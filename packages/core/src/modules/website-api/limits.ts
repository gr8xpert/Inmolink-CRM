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
 * - **Suspicious** (honeytokens, `no-store`): only a caller that tripped a flag — this request is deep, or its browser
 *   is flagged.
 */

import type {
  RateLimitCheck,
  RateLimiter,
  RateLimitResult,
  RateLimitRule,
  RateScope,
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
  facts: Pick<WebsiteRequestFacts, 'ip' | 'paged' | 'write'> & { depth?: number },
): WebsiteCheck[] {
  const l = websiteLimits();
  const tier = tierName(key.rateTier);
  const secret = key.kind === 'SECRET';
  const browser = `${key.keyId}|${facts.ip}`;
  const keyWide: Role = secret ? 'enforce' : 'observe';
  // Alert-only key-wide rules box themselves for an hour once over, so they alert once, not on every request.
  const alertBox = secret ? {} : { penaltySeconds: l.pagingPenaltySeconds };
  const checks: WebsiteCheck[] = [
    { rule: identity.apiKeyRateRule(key.rateTier), identity: key.keyId, role: 'enforce' },
    { rule: identity.API_KEY_AGENCY_RULE, identity: key.agencyId, role: 'enforce' },
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
  if (!facts.paged) return checks;
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

const ALERT_ACTION = { throttle: 'throttled', flag: 'flagged', observe: 'observed' } as const;

/**
 * Checks one website API request against its quotas and limits (one Redis round trip) and raises
 * `WebsiteScrapingDetected` when a rule trips. Fails open like every website limit (Redis down must not take every
 * website offline): the limiter answers allowed.
 */
export async function checkWebsiteLimits(
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
  }));
  const results = await limiter.consumeMany(calls, { slot: key.agencyId });
  let suspicious = facts.paged && depth >= l.deepPage;
  let worst: { check: WebsiteCheck; result: RateLimitResult } | undefined;
  checks.forEach((check, i) => {
    const result = results[i] as RateLimitResult;
    if (result.tripped && check.role in ALERT_ACTION) {
      raiseWebsiteAlert({
        kind: 'scraping',
        rule: check.rule.name,
        action: ALERT_ACTION[check.role as keyof typeof ALERT_ACTION],
        scope: check.rule.scope === 'ip' ? 'browser' : 'key',
        keyId: key.keyId,
        keyKind: key.kind,
        agencyId: key.agencyId,
        siteId: key.siteId,
        requestId: facts.requestId,
      });
    }
    if (check.role === 'flag' && (result.tripped || result.penalized)) suspicious = true;
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
