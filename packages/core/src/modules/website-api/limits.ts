/**
 * Website API quotas, bursts and anti-scraping limits (S7-04, PLAN §9.2 §12), checked by feed-api's `requireApiKey`
 * once the key is known. All rules go to the limits Redis in one script call (one round trip, no database statement),
 * every key of the call in the agency's hash slot.
 *
 * - **Secret keys** (a site's server, e.g. the WordPress plugin, pages for all its visitors): tier rate, agency
 *   ceiling, burst and daily quota are enforced key-wide (the quota counted only when every enforced rule allowed).
 * - **Publishable keys** (browser widgets): enforced **per browser** (key × client IP /64: rate, burst, daily share);
 *   the key-wide burst and daily quota only alert, so a few clients cannot use up a site.
 * - **Pagination anomaly detection:** a `/v2/listings` cursor chain at depth ≥ `deepPage` (the signed depth in the
 *   cursor) flags the caller (alert `WebsiteScrapingDetected`, action `flagged`) and its deep pages are counted: past
 *   `deepPerHour` it is throttled for an hour (`throttled`). A publishable-key browser is also flagged and throttled on
 *   paging volume; a publishable key's key-wide paging volume only alerts. Volume never flags a secret key.
 * - **Filter-slicing** (S7-F7): distinct filtered first pages of `/v2/listings` per window (a HyperLogLog per identity)
 *   flag and then throttle a publishable browser; key-wide they only alert.
 * - **Detail / sitemap sync** (S7-F7): detail and sitemap requests per window, net of the UPSERTs the caller read from
 *   `/v2/changes` (a credit), flag and then throttle a publishable browser; key-wide they only alert.
 * - **Per-agency daily quota** (S7-F7): keyed by the agency over all its sites and keys (rotation does not reset it),
 *   enforced for secret keys and counted last; publishable keys count apart and only alert.
 * - **Suspicious** (honeytokens, `no-store`): only a caller that tripped a flag — this request is deep, or its browser
 *   is flagged.
 */

import { LegacyPropertiesQuery, WebsiteDevelopmentsQuery, WebsiteListingsQuery } from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import {
  LocalFixedWindows,
  type LocalWindowCheck,
  type RateLimitCheck,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
  type RateScope,
} from '@inmolink/platform/rate-limit';
import type { ApiKeyPrincipal } from '../identity';
import * as identity from '../identity';
import { raiseWebsiteAlert } from './alerts';
import { readSearchCursor } from './cursor';
import { websiteLimits } from './settings';

export interface WebsiteRequestFacts {
  /** The client IP bucket (`ipBucket(request.ip)`; trusted proxies only). */
  ip: string;
  /** A paged request: a `cursor` on a list endpoint. */
  paged: boolean;
  /** `/v2/listings` with a cursor: the cursor, whose signed depth the deep-paging rules read. */
  listingsCursor?: string;
  /** A website form post (S7-05: lead or viewing request): the form-spam limits apply too. */
  write?: boolean;
  /** A filtered first page of `/v2/listings` or `/v2/developments`: its `sliceSignature` (S7-F7 filter-slicing). */
  filterSignature?: string;
  /** A detail or sitemap request (S7-F7 sync counting). */
  sync?: boolean;
  requestId: string;
}

export type WebsiteLimitDecision =
  | {
      allowed: true;
      /** The caller tripped a scraping flag: honeytokens may go on its deep pages; never cache its answers. */
      suspicious: boolean;
    }
  | {
      allowed: false;
      /** `quota`: 429 `QUOTA_EXCEEDED` with the reset time; `rate`: 429 `RATE_LIMITED`. */
      kind: 'quota' | 'rate';
      scope: RateScope;
      limit: number;
      resetAtMs: number;
      retryAfterSeconds: number;
    };

/**
 * `enforce`: a denial refuses the request; `quota`: the same, counted last, answered `QUOTA_EXCEEDED`; `throttle`: an
 * enforced penalty box that alerts when it trips; `flag`: alert-only, a trip (or running penalty) makes the caller
 * suspicious; `observe`: alert-only.
 */
type Role = 'enforce' | 'quota' | 'throttle' | 'flag' | 'observe';

export interface WebsiteCheck {
  rule: RateLimitRule;
  identity: string;
  role: Role;
  /** Counts distinct values (S7-F7 filter signatures), not requests. */
  distinct?: string;
  /** Allowance raised by the identity's change-feed credit (S7-F7 sync counting). */
  creditPool?: string;
  /** Only reads whether the rule's penalty runs (a flag set on another request kind; S7-F7). */
  peek?: boolean;
}

/** The credit pool a secret key's `/v2/changes` UPSERTs go to and its key-wide sync rule reads (S7-F7). */
export const SYNC_CREDIT_POOL = 'feed.sync';

/** Search fields that slice the inventory (S7-F7), per endpoint; `sort` is added to a filtered listings signature. */
const SLICE_FIELDS = {
  listings: [
    'q',
    'kind',
    'developmentId',
    'development',
    'status',
    'transaction',
    'types',
    'locations',
    'features',
    'priceMin',
    'priceMax',
    'bedsMin',
    'bathsMin',
    'areaMin',
    'areaMax',
    'bbox',
  ],
  developments: ['locations'],
  // S8-02: the v1 shim's `/v1/properties` (legacy parameter names; `sort` is added like listings).
  'legacy-properties': ['q', 'type', 'location', 'feature', 'transaction', 'min_price', 'max_price', 'beds', 'baths'],
} as const;

export type SliceEndpoint = keyof typeof SLICE_FIELDS;

/** One parsed value in canonical form: numbers as numbers print, text case-folded, lists sorted (a box keeps order). */
function canonical(field: string, value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(field, v));
    return field === 'bbox' ? items.join(',') : [...new Set(items)].sort().join(',');
  }
  if (typeof value === 'number') return String(value);
  return String(value).trim().toLowerCase();
}

/**
 * The slice signature of a first page (S7-F7 filter-slicing): the request's query **as the endpoint parses it** (the
 * contract's Zod schema), only the fields that filter the inventory, in canonical form (`0100000` = `100000`,
 * `types=b,a` = `types=a,b`, text case-folded), plus the sort for listings. Unknown parameters cannot inflate it: the
 * schemas are strict, so such a request is refused (400) and has no signature; nor can `limit`, `lang`, `facets`, `_k`.
 * The v1 shim's legacy schema (S8-02) drops unknown parameters instead: they are not in its field list either.
 * Undefined without a filter (an unfiltered first page slices nothing).
 */
export function sliceSignature(endpoint: SliceEndpoint, rawQuery: unknown): string | undefined {
  const schema =
    endpoint === 'listings'
      ? WebsiteListingsQuery
      : endpoint === 'legacy-properties'
        ? LegacyPropertiesQuery
        : WebsiteDevelopmentsQuery;
  const parsed = schema.safeParse(rawQuery ?? {});
  if (!parsed.success) return undefined;
  const query = parsed.data as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of SLICE_FIELDS[endpoint]) {
    const value = query[field];
    if (value !== undefined) parts.push(`${field}=${canonical(field, value)}`);
  }
  if (parts.length === 0) return undefined;
  if (endpoint !== 'developments') parts.push(`sort=${String(query.sort)}`);
  return `${endpoint}|${parts.join('&')}`;
}

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const tierName = (tier: ApiKeyPrincipal['rateTier']) => tier.toLowerCase();

/** The page depth a request's listings cursor carries (0: first page, or a cursor that is not this site's). */
export function depthOf(key: ApiKeyPrincipal, cursor: string | undefined): number {
  if (!cursor || !key.siteId) return 0;
  return readSearchCursor(key.siteId, cursor)?.depth ?? 0;
}

/** The rules one request is checked against (in this order: the key's tier first). */
export function websiteRequestChecks(
  key: ApiKeyPrincipal,
  facts: Pick<WebsiteRequestFacts, 'ip' | 'paged' | 'write' | 'filterSignature' | 'sync'> & { depth?: number },
): WebsiteCheck[] {
  const l = websiteLimits();
  const tier = tierName(key.rateTier);
  const secret = key.kind === 'SECRET';
  const browser = `${key.keyId}|${facts.ip}`;
  const keyWide: Role = secret ? 'enforce' : 'observe';
  // Alert-only key-wide rules box themselves for an hour once over, so they alert once, not on every request.
  const alertBox = secret ? {} : { penaltySeconds: l.pagingPenaltySeconds };
  // S7-F9 security review: the key tier and the agency's per-minute ceiling are enforced for secret keys only. Browser
  // traffic counts in pools of its own (`.pk` names) and only alerts — S7-04's rule for publishable key-wide limits — so
  // browsers from many IPs can neither shut out a site's other visitors nor use up the ceiling the agency's servers
  // (secret keys) run under. Browsers are held per browser, and per IP over all publishable keys (`publishableIpCheck`).
  const tierRule = identity.apiKeyRateRule(key.rateTier);
  const checks: WebsiteCheck[] = [
    secret
      ? { rule: tierRule, identity: key.keyId, role: 'enforce' }
      : { rule: { ...tierRule, name: `feed.key.pk.${tier}`, ...alertBox }, identity: key.keyId, role: 'observe' },
    secret
      ? { rule: identity.API_KEY_AGENCY_RULE, identity: key.agencyId, role: 'enforce' }
      : {
          rule: { ...identity.API_KEY_AGENCY_RULE, name: 'feed.agency.pk', ...alertBox },
          identity: key.agencyId,
          role: 'observe',
        },
    {
      rule: {
        name: `feed.burst.${tier}`,
        scope: 'key',
        limit: l.burst[key.rateTier],
        windowSeconds: l.burstWindowSeconds,
        ...alertBox,
      },
      identity: key.keyId,
      role: keyWide,
    },
    {
      rule: {
        name: `feed.quota.${tier}`,
        scope: 'key',
        limit: l.dailyQuota[key.rateTier],
        windowSeconds: DAY_SECONDS,
        fixedWindow: true,
        ...alertBox,
      },
      identity: key.keyId,
      role: secret ? 'quota' : 'observe',
    },
    // S7-F7: the agency's day over all its sites and keys (keyed by the agency: a new or rotated key starts no new
    // budget). Publishable traffic counts apart and only alerts, so browsers cannot lock out the agency's servers.
    {
      rule: {
        name: secret ? 'feed.agency.quota' : 'feed.agency.pk.day',
        scope: 'tenant',
        limit: l.agencyDailyQuota,
        windowSeconds: DAY_SECONDS,
        fixedWindow: true,
        ...(secret ? {} : { penaltySeconds: l.pagingPenaltySeconds }),
      },
      identity: key.agencyId,
      role: secret ? 'quota' : 'observe',
    },
  ];
  if (!secret) {
    checks.push(
      {
        rule: { name: 'feed.browser', scope: 'ip', limit: l.browserPerMinute, windowSeconds: 60 },
        identity: browser,
        role: 'enforce',
      },
      {
        rule: { name: 'feed.browser.burst', scope: 'ip', limit: l.browserBurst, windowSeconds: l.burstWindowSeconds },
        identity: browser,
        role: 'enforce',
      },
      {
        rule: {
          name: 'feed.browser.day',
          scope: 'ip',
          limit: l.browserPerDay,
          windowSeconds: DAY_SECONDS,
          fixedWindow: true,
        },
        identity: browser,
        role: 'quota',
      },
    );
  }
  if (facts.write) {
    // Form spam (S7-05): a browser's posts (publishable keys), or a site server's (secret keys) per hour.
    if (secret) {
      checks.push({
        rule: {
          name: `feed.leads.key.${tier}`,
          scope: 'key',
          limit: l.leadsPerKeyHour[key.rateTier],
          windowSeconds: HOUR_SECONDS,
        },
        identity: key.keyId,
        role: 'enforce',
      });
    } else {
      checks.push(
        {
          rule: {
            name: 'feed.leads.browser',
            scope: 'ip',
            limit: l.leadsPerBrowser,
            windowSeconds: l.leadWindowSeconds,
          },
          identity: browser,
          role: 'enforce',
        },
        {
          rule: {
            name: 'feed.leads.browser.day',
            scope: 'ip',
            limit: l.leadsPerBrowserDay,
            windowSeconds: DAY_SECONDS,
            fixedWindow: true,
          },
          identity: browser,
          role: 'enforce',
        },
      );
    }
  }
  if (facts.filterSignature !== undefined) checks.push(...sliceChecks(key, browser, facts.filterSignature));
  if (facts.sync) checks.push(...syncChecks(key, browser));
  if (!facts.paged) return checks;
  if (!secret) {
    // S7-F7: a browser flagged for slicing or a detail crawl (on other requests) is suspicious on its paged ones —
    // honeytokens on its deep pages, never cached. Only its penalty is read (same rule, same keys); nothing counted.
    const [sliceFlag] = sliceChecks(key, browser, '');
    const [syncFlag] = syncChecks(key, browser);
    for (const flag of [sliceFlag, syncFlag]) {
      if (flag) checks.push({ rule: flag.rule, identity: browser, role: 'flag', peek: true });
    }
  }
  const deepIdentity = secret ? key.keyId : browser;
  const deepScope: RateScope = secret ? 'key' : 'ip';
  if ((facts.depth ?? 0) >= l.deepPage) {
    checks.push(
      // One alert per hour per caller: the second deep page trips it (the first is already suspicious, by depth).
      {
        rule: {
          name: 'feed.deep.flag',
          scope: deepScope,
          limit: 1,
          windowSeconds: HOUR_SECONDS,
          penaltySeconds: HOUR_SECONDS,
        },
        identity: deepIdentity,
        role: 'flag',
      },
      {
        rule: {
          name: 'feed.deep',
          scope: deepScope,
          limit: l.deepPerHour,
          windowSeconds: HOUR_SECONDS,
          penaltySeconds: l.pagingPenaltySeconds,
        },
        identity: deepIdentity,
        role: 'throttle',
      },
    );
  }
  if (!secret) {
    const window = l.browserPagingWindowSeconds;
    checks.push(
      {
        rule: {
          name: 'feed.paging.browser.flag',
          scope: 'ip',
          limit: l.browserPagingFlag,
          windowSeconds: window,
          penaltySeconds: l.pagingPenaltySeconds,
        },
        identity: browser,
        role: 'flag',
      },
      {
        rule: {
          name: 'feed.paging.browser',
          scope: 'ip',
          limit: l.browserPagingLimit,
          windowSeconds: window,
          penaltySeconds: l.pagingPenaltySeconds,
        },
        identity: browser,
        role: 'throttle',
      },
      {
        rule: {
          name: `feed.paging.pk.${tier}`,
          scope: 'key',
          limit: l.pagingPerKeyHour[key.rateTier],
          windowSeconds: HOUR_SECONDS,
          penaltySeconds: l.pagingPenaltySeconds,
        },
        identity: key.keyId,
        role: 'observe',
      },
    );
  }
  return checks;
}

/** Filter-slicing (S7-F7): distinct filtered first pages per browser (flag, throttle) and key-wide (alert). */
function sliceChecks(key: ApiKeyPrincipal, browser: string, signature: string): WebsiteCheck[] {
  const l = websiteLimits();
  const window = { windowSeconds: l.sliceWindowSeconds, fixedWindow: true, penaltySeconds: l.pagingPenaltySeconds };
  const checks: WebsiteCheck[] = [];
  if (key.kind !== 'SECRET') {
    checks.push(
      {
        rule: { name: 'feed.slice.browser.flag', scope: 'ip', limit: l.sliceBrowserFlag, ...window },
        identity: browser,
        role: 'flag',
        distinct: signature,
      },
      {
        rule: { name: 'feed.slice.browser', scope: 'ip', limit: l.sliceBrowserLimit, ...window },
        identity: browser,
        role: 'throttle',
        distinct: signature,
      },
    );
  }
  checks.push({
    rule: {
      name: `feed.slice.key.${tierName(key.rateTier)}`,
      scope: 'key',
      limit: l.slicePerKey[key.rateTier],
      ...window,
    },
    identity: key.keyId,
    role: 'observe',
    distinct: signature,
  });
  return checks;
}

/**
 * Detail / sitemap sync (S7-F7): per browser (flag, throttle) and key-wide (alert); a secret key's allowance is raised
 * by the change-feed entries it read (`creditChangeFeed`). Publishable keys get no credit.
 */
function syncChecks(key: ApiKeyPrincipal, browser: string): WebsiteCheck[] {
  const l = websiteLimits();
  const window = { windowSeconds: l.syncWindowSeconds, penaltySeconds: l.pagingPenaltySeconds };
  const checks: WebsiteCheck[] = [];
  const secret = key.kind === 'SECRET';
  if (!secret) {
    checks.push(
      // No change-feed credit for browsers: a site syncs from `/v2/changes` with its secret key (WordPress plugin).
      {
        rule: { name: 'feed.sync.browser.flag', scope: 'ip', limit: l.syncBrowserFlag, ...window },
        identity: browser,
        role: 'flag',
      },
      {
        rule: { name: 'feed.sync.browser', scope: 'ip', limit: l.syncBrowserLimit, ...window },
        identity: browser,
        role: 'throttle',
      },
    );
  }
  checks.push({
    rule: {
      name: `feed.sync.key.${tierName(key.rateTier)}`,
      scope: 'key',
      limit: l.syncPerKey[key.rateTier],
      ...window,
    },
    identity: key.keyId,
    role: 'observe',
    ...(secret ? { creditPool: SYNC_CREDIT_POOL } : {}),
  });
  return checks;
}

/**
 * Credits a **secret** key with the change-feed entries it was sent (S7-F7): one detail per UPSERT (`ref` +
 * `changedAt`) it has not been credited for within `syncCreditSeenSeconds` — re-reading a page, or the whole feed with
 * an old `since`, earns nothing again — for `syncWindowSeconds`, capped at `syncCreditCap`. Publishable keys earn
 * nothing (a browser has no reason to sync). Fire-and-forget from the route: never throws (the limiter counts and logs
 * failures). Answers the credits granted.
 */
export async function creditChangeFeed(
  limiter: RateLimiter,
  key: ApiKeyPrincipal,
  changes: readonly { ref: string; change: string; changedAt: string }[],
): Promise<number> {
  if (key.kind !== 'SECRET') return 0;
  const items = changes.filter((c) => c.change === 'UPSERT').map((c) => `${c.ref}|${c.changedAt}`);
  if (items.length === 0) return 0;
  const l = websiteLimits();
  return limiter.credit(SYNC_CREDIT_POOL, key.keyId, items, {
    slot: key.agencyId,
    cap: l.syncCreditCap,
    ttlSeconds: l.syncWindowSeconds,
    seenSeconds: Math.max(l.syncCreditSeenSeconds, l.syncWindowSeconds),
  });
}

const ALERT_ACTION = { throttle: 'throttled', flag: 'flagged', observe: 'observed' } as const;

/**
 * Publishable requests per client IP over every publishable key (S7-F9 security review), enforced. In the IP's own
 * Redis slot — not the agency's: copies of different agencies' widget keys must share it — so a second script call.
 */
function publishableIpRule(): RateLimitRule {
  return { name: 'feed.pk.ip', scope: 'ip', limit: websiteLimits().publishablePerIpMinute, windowSeconds: 60 };
}

/**
 * Form posts this process let through (S8-F4): the caps that hold while the limits Redis fails open (it fails open so
 * an outage does not take websites offline; without these a leaked secret key stating `serverVerified: true` could post
 * leads, and trigger acknowledgement e-mails, without bound).
 *
 * - **Same limits as the shared form-spam rules**, fixed windows, so while Redis answers the shared rule denies first
 *   (the publishable per-key cap has no shared twin: it alone refuses a widget site posting more than
 *   `leadsPerKeyHour` leads an hour through one process). Per process: N processes let up to N × a cap through.
 * - **Pools (S8-F6 `LocalFixedWindows`):** `key` (an hour) and `browser` (key × client IP, `leadWindowSeconds`) are
 *   tracked apart, so a flood of browser identities never evicts a key's window. A full pool never refuses for lack of
 *   room: it evicts its oldest window under its limit, or lets the post through untracked when every window is at its
 *   limit (a browser's post is then still bounded by its key's cap). Accepted: someone holding more than
 *   `LOCAL_WRITE_TRACKED` keys can rotate the `key` pool during an outage (each key still counts in the shared rules).
 * - **Not covered:** the iFrame embed pages' lead posts (`checkEmbedLimits`): each needs a Turnstile token solved on the
 *   public origin (fail closed without Turnstile), and acknowledgements are capped per site and day in the database.
 */
export const LOCAL_WRITE_TRACKED = 10_000;

type LocalWritePool = 'key' | 'browser';

/** In-process form-post windows (exported for tests; `size` per pool). */
export function createLocalWriteWindows(
  max = LOCAL_WRITE_TRACKED,
  browserWindowMs = websiteLimits().leadWindowSeconds * 1_000,
): LocalFixedWindows<LocalWritePool> {
  return new LocalFixedWindows<LocalWritePool>({
    key: { max, windowMs: HOUR_SECONDS * 1_000 },
    browser: { max, windowMs: browserWindowMs },
  });
}

let localWrites: LocalFixedWindows<LocalWritePool> | undefined;

/** The process's form-post windows, rebuilt when `leadWindowSeconds` changes (one length per pool). */
function localWriteWindows(): LocalFixedWindows<LocalWritePool> {
  const browserWindowMs = websiteLimits().leadWindowSeconds * 1_000;
  if (localWrites?.windowMs('browser') !== browserWindowMs) {
    localWrites = createLocalWriteWindows(LOCAL_WRITE_TRACKED, browserWindowMs);
  }
  return localWrites;
}

/** Tests: forget the in-process form-post counts. */
export function resetLocalWriteCaps(): void {
  localWrites = undefined;
}

/**
 * The in-process caps of a form post (S8-F4): per key per hour (`feed.leads.key.*`'s limit — publishable keys too),
 * and for publishable keys per browser per `leadWindowSeconds` (`feed.leads.browser`).
 */
function localWriteCaps(key: ApiKeyPrincipal, ip: string): LocalWindowCheck<LocalWritePool>[] {
  const l = websiteLimits();
  const perKey: LocalWindowCheck<LocalWritePool> = {
    identity: `${key.kind === 'SECRET' ? 'k' : 'pk'}|${key.keyId}`,
    limit: l.leadsPerKeyHour[key.rateTier],
    pool: 'key',
  };
  if (key.kind === 'SECRET') return [perKey];
  return [
    perKey,
    {
      identity: `b|${key.keyId}|${ip}`,
      limit: l.leadsPerBrowser,
      pool: 'browser',
    },
  ];
}

/**
 * Checks one website API request against its quotas and limits (one Redis round trip) and raises
 * `WebsiteScrapingDetected` when a rule trips. Fails open like every website limit (Redis down must not take every
 * website offline): the limiter answers allowed. Form posts first take a post from their in-process caps (S8-F4,
 * `LocalFixedWindows`, synchronously, before the round trip), given back when the shared limits refuse, so an outage does
 * not leave lead writes unbounded.
 */
export async function checkWebsiteLimits(
  limiter: RateLimiter,
  key: ApiKeyPrincipal,
  facts: WebsiteRequestFacts,
): Promise<WebsiteLimitDecision> {
  if (!facts.write) return sharedLimits(limiter, key, facts);
  const reservation = localWriteWindows().reserve(localWriteCaps(key, facts.ip));
  if (!reservation.allowed) {
    return {
      allowed: false,
      kind: 'rate',
      scope: reservation.check.pool === 'key' ? 'key' : 'ip',
      limit: reservation.check.limit,
      resetAtMs: clock.nowMs() + reservation.retryAfterSeconds * 1_000,
      retryAfterSeconds: reservation.retryAfterSeconds,
    };
  }
  let decision: WebsiteLimitDecision | undefined;
  try {
    decision = await sharedLimits(limiter, key, facts);
    return decision;
  } finally {
    if (!decision?.allowed) reservation.release();
  }
}

/** The shared (Redis) limits of one request. */
async function sharedLimits(
  limiter: RateLimiter,
  key: ApiKeyPrincipal,
  facts: WebsiteRequestFacts,
): Promise<WebsiteLimitDecision> {
  const l = websiteLimits();
  const depth = depthOf(key, facts.listingsCursor);
  const checks = websiteRequestChecks(key, { ...facts, depth });
  const calls: RateLimitCheck[] = checks.map((c) => ({
    rule: c.rule,
    identity: c.identity,
    observe: c.role === 'flag' || c.role === 'observe',
    countLast: c.role === 'quota',
    ...(c.distinct !== undefined ? { distinct: c.distinct } : {}),
    ...(c.creditPool !== undefined ? { creditPool: c.creditPool } : {}),
    ...(c.peek === true ? { peek: true } : {}),
  }));
  const [results, ipResults] = await Promise.all([
    limiter.consumeMany(calls, { slot: key.agencyId }),
    key.kind === 'SECRET'
      ? Promise.resolve([] as RateLimitResult[])
      : limiter.consumeMany([{ rule: publishableIpRule(), identity: facts.ip }], { slot: facts.ip }),
  ]);
  const ipResult = ipResults[0];
  if (ipResult && !ipResult.allowed) {
    return {
      allowed: false,
      kind: 'rate',
      scope: 'ip',
      limit: ipResult.limit,
      resetAtMs: ipResult.resetAtMs,
      retryAfterSeconds: ipResult.retryAfterSeconds,
    };
  }
  let suspicious = facts.paged && depth >= l.deepPage;
  let worst: { check: WebsiteCheck; result: RateLimitResult } | undefined;
  checks.forEach((check, i) => {
    const result = results[i] as RateLimitResult;
    if (result.tripped && check.role in ALERT_ACTION) {
      raiseWebsiteAlert({
        kind: 'scraping',
        rule: check.rule.name,
        action: ALERT_ACTION[check.role as keyof typeof ALERT_ACTION],
        scope: check.rule.scope === 'ip' ? 'browser' : check.rule.scope === 'tenant' ? 'agency' : 'key',
        keyId: key.keyId,
        keyKind: key.kind,
        agencyId: key.agencyId,
        siteId: key.siteId,
        requestId: facts.requestId,
      });
    }
    // Suspicion only on paged requests (S7-06 Decision 3): a first page is the key's shared answer and carries no
    // honeytoken; a flag tripped on one (slicing) or on a detail (sync) shows on the browser's paged requests (peeks).
    if (check.role === 'flag' && facts.paged && (result.tripped || result.penalized)) suspicious = true;
    if (result.allowed || check.role === 'flag' || check.role === 'observe') return;
    if (!worst || result.retryAfterSeconds > worst.result.retryAfterSeconds) worst = { check, result };
  });
  if (!worst) return { allowed: true, suspicious };
  return {
    allowed: false,
    kind: worst.check.role === 'quota' ? 'quota' : 'rate',
    scope: worst.check.rule.scope,
    limit: worst.result.limit,
    resetAtMs: worst.result.resetAtMs,
    retryAfterSeconds: worst.result.retryAfterSeconds,
  };
}
