import { type WebsiteCard, WebsiteListingCard } from '@inmolink/contracts';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import type { RateLimitCheck, RateLimiter, RateLimitResult, RateLimitRule } from '@inmolink/platform/rate-limit';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyPrincipal } from '../../identity';
import { wrapSearchCursor } from '../cursor';
import {
  honeytokenCard,
  honeytokenCode,
  honeytokenKind,
  honeytokenSiteOf,
  isHoneytokenCode,
  isHoneytokenRef,
  withHoneytoken,
} from '../honeytokens';
import {
  checkWebsiteLimits,
  createLocalWriteWindows,
  creditChangeFeed,
  resetLocalWriteCaps,
  SYNC_CREDIT_POOL,
  sliceSignature,
  websiteRequestChecks,
} from '../limits';
import { configureWebsiteApi, type WebsiteAlert } from '../settings';

/** Quotas, paging rules and honeytokens (S7-04) without Redis: a scripted limiter. */

const KEY = 'test-cursor-key-0123456789abcdef0123';
const alerts: WebsiteAlert[] = [];

beforeEach(() => {
  alerts.length = 0;
  resetLocalWriteCaps();
  configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: KEY, onAlert: (a) => alerts.push(a) });
});

const secret: ApiKeyPrincipal = {
  keyId: '01900000-0000-7000-8000-000000000001',
  agencyId: '01900000-0000-7000-8000-0000000000a1',
  kind: 'SECRET',
  scopes: ['listings:read'],
  rateTier: 'STANDARD',
  siteId: '01900000-0000-7000-8000-000000000051',
  legacyQueryKey: false,
};
const widget: ApiKeyPrincipal = { ...secret, keyId: '01900000-0000-7000-8000-000000000002', kind: 'PUBLISHABLE' };
const facts = { ip: '203.0.113.7', paged: true, requestId: 'req-1' };

/** Answers each rule from `script` (by rule name); allowed with nothing used otherwise. Records what was sent. */
function scripted(
  script: Record<string, Partial<RateLimitResult>>,
  seen: { checks: RateLimitCheck[]; slot?: string }[] = [],
): RateLimiter {
  const consume = (rule: RateLimitRule): RateLimitResult => ({
    allowed: true,
    limit: rule.limit,
    remaining: rule.limit,
    retryAfterSeconds: 0,
    resetAtMs: 0,
    ...script[rule.name],
  });
  return {
    consumeMany: async (checks: readonly RateLimitCheck[], options: { slot?: string } = {}) => {
      seen.push({ checks: [...checks], slot: options.slot });
      return checks.map((c) => consume(c.rule));
    },
  } as unknown as RateLimiter;
}

describe('website API limits (S7-04)', () => {
  it('[S7-04] secret keys: key-wide burst and quota; publishable keys: per browser, key-wide only alerts; deep paging rules', () => {
    const names = (k: ApiKeyPrincipal, paged: boolean, depth = 0) =>
      websiteRequestChecks(k, { ip: facts.ip, paged, depth }).map((c) => `${c.rule.name}:${c.role}`);
    expect(names(secret, false)).toEqual([
      'feed.key.standard:enforce',
      'feed.agency:enforce',
      'feed.burst.standard:enforce',
      'feed.quota.standard:quota',
      'feed.agency.quota:quota',
    ]);
    // Volume never flags a secret key: paging adds nothing until a cursor chain is deep.
    expect(names(secret, true, 49)).toEqual(names(secret, false));
    expect(names(secret, true, 50)).toEqual([...names(secret, false), 'feed.deep.flag:flag', 'feed.deep:throttle']);
    expect(names(widget, true)).toEqual([
      // S7-F9 security review: browser traffic has its own key-wide and agency pools, alert only.
      'feed.key.pk.standard:observe',
      'feed.agency.pk:observe',
      'feed.burst.standard:observe',
      'feed.quota.standard:observe',
      'feed.agency.pk.day:observe',
      'feed.browser:enforce',
      'feed.browser.burst:enforce',
      'feed.browser.day:quota',
      // S7-F7: peeks at the browser's slicing and sync flags.
      'feed.slice.browser.flag:flag',
      'feed.sync.browser.flag:flag',
      'feed.paging.browser.flag:flag',
      'feed.paging.browser:throttle',
      'feed.paging.pk.standard:observe',
    ]);
    const quota = websiteRequestChecks(secret, facts).find((c) => c.role === 'quota');
    expect(quota?.rule).toMatchObject({ windowSeconds: 86_400, fixedWindow: true, limit: 100_000 });
    // The browser's identity is the key and the client IP together: one page's visitors do not share it.
    const browser = websiteRequestChecks(widget, facts).find((c) => c.rule.name === 'feed.browser');
    expect(browser?.identity).toBe(`${widget.keyId}|${facts.ip}`);
  });

  it('[S7-04] one call in the agency slot; quotas count last; alert-only rules never refuse', async () => {
    const seen: { checks: RateLimitCheck[]; slot?: string }[] = [];
    await checkWebsiteLimits(scripted({}, seen), widget, facts);
    // S7-F9: a publishable request also counts in its IP's own slot (`feed.pk.ip`, over every publishable key).
    expect(seen).toHaveLength(2);
    expect(seen[0]?.slot).toBe(widget.agencyId);
    expect(seen[1]).toMatchObject({ slot: facts.ip, checks: [{ rule: { name: 'feed.pk.ip' }, identity: facts.ip }] });
    const secretSeen: { checks: RateLimitCheck[]; slot?: string }[] = [];
    await checkWebsiteLimits(scripted({}, secretSeen), secret, facts);
    expect(secretSeen).toHaveLength(1);
    const sent = Object.fromEntries((seen[0]?.checks ?? []).map((c) => [c.rule.name, c]));
    expect(sent['feed.browser.day']).toMatchObject({ countLast: true, observe: false });
    expect(sent['feed.quota.standard']).toMatchObject({ countLast: false, observe: true });
    expect(sent['feed.browser']).toMatchObject({ countLast: false, observe: false });
    // The publishable key's key-wide quota and burst over: alert, not 429.
    const over = await checkWebsiteLimits(
      scripted({
        'feed.quota.standard': { allowed: false, remaining: 0, retryAfterSeconds: 9, tripped: true },
        'feed.burst.standard': { allowed: false, remaining: 0, retryAfterSeconds: 9, penalized: true },
      }),
      widget,
      facts,
    );
    expect(over).toEqual({ allowed: true, suspicious: false });
    expect(alerts).toEqual([expect.objectContaining({ action: 'observed', rule: 'feed.quota.standard' })]);
  });

  it('[S7-04] exceeding the daily quota is a quota answer with its reset time', async () => {
    const midnight = Date.UTC(2026, 9, 22);
    const quota = { allowed: false, remaining: 0, retryAfterSeconds: 3_600, resetAtMs: midnight };
    const decision = await checkWebsiteLimits(scripted({ 'feed.quota.standard': quota }), secret, {
      ...facts,
      paged: false,
    });
    expect(decision).toEqual({
      allowed: false,
      kind: 'quota',
      scope: 'key',
      limit: 100_000,
      resetAtMs: midnight,
      retryAfterSeconds: 3_600,
    });
    // A browser's daily share is a quota answer too, scoped to the browser.
    const share = await checkWebsiteLimits(scripted({ 'feed.browser.day': quota }), widget, facts);
    expect(share).toMatchObject({ allowed: false, kind: 'quota', scope: 'ip', resetAtMs: midnight });
    // A burst denial is a rate answer.
    const burst = await checkWebsiteLimits(
      scripted({ 'feed.burst.standard': { allowed: false, remaining: 0, retryAfterSeconds: 2 } }),
      secret,
      facts,
    );
    expect(burst).toMatchObject({ allowed: false, kind: 'rate', scope: 'key', retryAfterSeconds: 2 });
  });

  it('[S7-04] a busy secret key with many shallow pagers is not suspicious; a deep cursor chain is', async () => {
    // Every paging counter near its top: volume alone says nothing about a secret key.
    const busy = scripted({
      'feed.key.standard': { remaining: 1 },
      'feed.burst.standard': { remaining: 1 },
    });
    const cursorAt = (depth: number) => wrapSearchCursor(secret.siteId as string, depth, 'inner-cursor');
    for (const depth of [1, 9, 10, 49]) {
      expect(await checkWebsiteLimits(busy, secret, { ...facts, listingsCursor: cursorAt(depth) })).toEqual({
        allowed: true,
        suspicious: false,
      });
    }
    expect(alerts).toEqual([]);
    expect(await checkWebsiteLimits(busy, secret, { ...facts, listingsCursor: cursorAt(50) })).toEqual({
      allowed: true,
      suspicious: true,
    });
    // A forged depth is no depth.
    const forged = `${cursorAt(50).slice(0, 3)}${'x'.repeat(11)}inner-cursor`;
    expect(await checkWebsiteLimits(busy, secret, { ...facts, listingsCursor: forged })).toEqual({
      allowed: true,
      suspicious: false,
    });
  });

  it('[S7-04] flags and throttles: a flag alerts and makes the caller suspicious; a throttle refuses and alerts', async () => {
    const flagged = await checkWebsiteLimits(
      scripted({
        'feed.paging.browser.flag': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true },
      }),
      widget,
      facts,
    );
    expect(flagged).toEqual({ allowed: true, suspicious: true });
    expect(alerts).toEqual([expect.objectContaining({ action: 'flagged', scope: 'browser', keyKind: 'PUBLISHABLE' })]);
    // Still flagged: suspicious, no second alert.
    alerts.length = 0;
    const still = await checkWebsiteLimits(
      scripted({
        'feed.paging.browser.flag': { allowed: false, remaining: 0, retryAfterSeconds: 99, penalized: true },
      }),
      widget,
      facts,
    );
    expect(still).toEqual({ allowed: true, suspicious: true });
    expect(alerts).toEqual([]);

    const throttled = await checkWebsiteLimits(
      scripted({ 'feed.paging.browser': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true } }),
      widget,
      facts,
    );
    expect(throttled).toMatchObject({ allowed: false, kind: 'rate', scope: 'ip', retryAfterSeconds: 3_600 });
    expect(alerts).toEqual([expect.objectContaining({ action: 'throttled', scope: 'browser' })]);

    alerts.length = 0;
    const deep = await checkWebsiteLimits(
      scripted({ 'feed.deep': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true } }),
      secret,
      { ...facts, listingsCursor: wrapSearchCursor(secret.siteId as string, 60, 'inner') },
    );
    expect(deep).toMatchObject({ allowed: false, scope: 'key' });
    expect(alerts).toEqual([expect.objectContaining({ action: 'throttled', scope: 'key', keyKind: 'SECRET' })]);

    const observed = await checkWebsiteLimits(
      scripted({
        'feed.paging.pk.standard': { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true },
      }),
      widget,
      facts,
    );
    expect(observed).toEqual({ allowed: true, suspicious: false });
  });
});

describe('website form posts while the limits Redis is down (S8-F4)', () => {
  it('[S8-F4] with the limiter failing open, lead writes on one key stop at the local cap', async () => {
    const clock = useFakeClock('2026-10-22T10:00:00Z');
    try {
      configureWebsiteApi({
        mediaBaseUrl: 'https://media.example',
        cursorKey: KEY,
        limits: { leadsPerKeyHour: { STANDARD: 3, HIGH: 10 }, leadsPerBrowser: 2 },
      });
      // What the limiter answers when its Redis call fails (fail open): every rule allowed.
      const failingOpen = scripted({});
      const post = (k: ApiKeyPrincipal, ip = facts.ip) =>
        checkWebsiteLimits(failingOpen, k, { ip, paged: false, write: true, requestId: 'req-lead' });

      for (let i = 0; i < 3; i++) expect(await post(secret)).toMatchObject({ allowed: true });
      const refused = await post(secret);
      expect(refused).toMatchObject({ allowed: false, kind: 'rate', scope: 'key', limit: 3 });
      expect(refused.allowed === false && refused.retryAfterSeconds).toBe(3_600);
      // Per key: another secret key of the agency still posts; reads on the capped key are not affected.
      expect(await post({ ...secret, keyId: '01900000-0000-7000-8000-000000000003' })).toMatchObject({ allowed: true });
      expect(await checkWebsiteLimits(failingOpen, secret, { ...facts, paged: false })).toMatchObject({
        allowed: true,
      });
      // Publishable keys: per browser (key × IP) at the browser's form limit.
      for (let i = 0; i < 2; i++) expect(await post(widget)).toMatchObject({ allowed: true });
      expect(await post(widget)).toMatchObject({ allowed: false, scope: 'ip', limit: 2 });
      expect(await post(widget, '198.51.100.9')).toMatchObject({ allowed: true });
      // …and per key (`leadsPerKeyHour`, 3 here): a fourth browser of the same widget key is refused key-wide.
      expect(await post(widget, '198.51.100.10')).toMatchObject({ allowed: false, scope: 'key', limit: 3 });
      // A post the shared limiter refused is not counted locally.
      const denying = scripted({ 'feed.leads.key.standard': { allowed: false, retryAfterSeconds: 60 } });
      const other = { ...secret, keyId: '01900000-0000-7000-8000-000000000004' };
      for (let i = 0; i < 5; i++) {
        await checkWebsiteLimits(denying, other, { ip: facts.ip, paged: false, write: true, requestId: 'r' });
      }
      expect(await post(other)).toMatchObject({ allowed: true });
      // The window ends: the key posts again.
      clock.advance(3_600_000);
      expect(await post(secret)).toMatchObject({ allowed: true });
    } finally {
      restoreClock();
    }
  });

  it('[S8-F4] concurrent posts while the limits Redis hangs: only the local cap passes', async () => {
    configureWebsiteApi({
      mediaBaseUrl: 'https://media.example',
      cursorKey: KEY,
      limits: { leadsPerKeyHour: { STANDARD: 3, HIGH: 10 } },
    });
    // A limiter whose round trip hangs until released, then fails open.
    let wake: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const hanging = {
      consumeMany: async (checks: readonly RateLimitCheck[]) => {
        await gate;
        return checks.map((c) => ({
          allowed: true,
          limit: c.rule.limit,
          remaining: 1,
          retryAfterSeconds: 0,
          resetAtMs: 0,
        }));
      },
    } as unknown as RateLimiter;
    const posts = Array.from({ length: 20 }, () =>
      checkWebsiteLimits(hanging, secret, { ip: facts.ip, paged: false, write: true, requestId: 'req-burst' }),
    );
    wake();
    const decisions = await Promise.all(posts);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    expect(decisions.filter((d) => !d.allowed && d.scope === 'key')).toHaveLength(17);
  });

  it('[S8-F4] tracks at most MAX_TRACKED identities; browser floods never evict a key window', () => {
    const clock = useFakeClock('2026-10-22T10:00:00Z');
    try {
      const caps = createLocalWriteWindows(5, 600_000);
      const keyCap = { identity: 'k|secret', limit: 2, pool: 'key' as const };
      const browser = (ip: string) => ({ identity: `b|widget|${ip}`, limit: 2, pool: 'browser' as const });
      expect(caps.reserve([keyCap])).toMatchObject({ allowed: true });
      expect(caps.reserve([keyCap])).toMatchObject({ allowed: true });
      for (let i = 0; i < 20; i++) expect(caps.reserve([browser(`ip${i}`)])).toMatchObject({ allowed: true });
      expect([caps.size('key'), caps.size('browser')]).toEqual([1, 5]);
      // The key's window survived the flood: still used up.
      expect(caps.reserve([keyCap])).toMatchObject({ allowed: false, retryAfterSeconds: 3_600 });
      // Expired browser windows are swept.
      clock.advance(600_000);
      expect(caps.reserve([browser('ip-new')])).toMatchObject({ allowed: true });
      expect([caps.size('key'), caps.size('browser')]).toEqual([1, 1]);
      // The key map is bounded too.
      for (let i = 0; i < 6; i++) caps.reserve([{ ...keyCap, identity: `k|${i}` }]);
      expect(caps.size('key')).toBe(5);
    } finally {
      restoreClock();
    }
  });

  it('[S8-F6] a full browser pool still lets a new browser post; windows at their limit survive', () => {
    useFakeClock('2026-10-23T10:00:00Z');
    try {
      const caps = createLocalWriteWindows(3, 600_000);
      const keyCap = { identity: 'pk|widget', limit: 100, pool: 'key' as const };
      const browser = (ip: string) => ({ identity: `b|widget|${ip}`, limit: 2, pool: 'browser' as const });
      // A browser at its limit, then a flood of new browsers filling the pool.
      caps.reserve([keyCap, browser('boxed')]);
      caps.reserve([keyCap, browser('boxed')]);
      for (let i = 0; i < 10; i++) {
        expect(caps.reserve([keyCap, browser(`flood${i}`)])).toMatchObject({ allowed: true });
      }
      expect(caps.size('browser')).toBe(3);
      expect(caps.reserve([keyCap, browser('boxed')])).toMatchObject({
        allowed: false,
        check: { pool: 'browser' },
        retryAfterSeconds: 600,
      });
      // Every window at its limit: a new browser goes through untracked, still counted on its key.
      const full = createLocalWriteWindows(2, 600_000);
      const smallKey = { ...keyCap, limit: 6 };
      for (const ip of ['a', 'a', 'b', 'b']) full.reserve([smallKey, browser(ip)]);
      expect(full.reserve([smallKey, browser('c')])).toMatchObject({ allowed: true });
      expect(full.size('browser')).toBe(2);
      expect(full.reserve([smallKey, browser('d')])).toMatchObject({ allowed: true });
      expect(full.reserve([smallKey, browser('e')])).toMatchObject({ allowed: false, check: { pool: 'key' } });
    } finally {
      restoreClock();
    }
  });

  it('[S8-F6] a released post frees the window it started', () => {
    const caps = createLocalWriteWindows(5, 600_000);
    const browser = { identity: 'b|widget|ip', limit: 2, pool: 'browser' as const };
    const first = caps.reserve([browser]);
    expect(caps.size('browser')).toBe(1);
    if (first.allowed) first.release();
    expect(caps.size('browser')).toBe(0);
    // A window someone else also holds stays.
    const a = caps.reserve([browser]);
    const b = caps.reserve([browser]);
    if (a.allowed) a.release();
    expect(caps.size('browser')).toBe(1);
    if (b.allowed) b.release();
    expect(caps.size('browser')).toBe(1);
  });
});

describe('website API extraction budgets (S7-F7)', () => {
  const names = (k: ApiKeyPrincipal, extra: { filterSignature?: string; sync?: boolean }) =>
    websiteRequestChecks(k, { ip: facts.ip, paged: false, ...extra }).map((c) => `${c.rule.name}:${c.role}`);

  it('[S7-F7] the slice signature: the parsed filters and sort in canonical form; junk and no-op parameters change nothing', () => {
    const T1 = '01900000-0000-7000-8000-0000000000e1';
    const T2 = '01900000-0000-7000-8000-0000000000e2';
    const L = '01900000-0000-7000-8000-0000000000f1';
    const a = sliceSignature('listings', { types: `${T2},${T1}`, locations: L, priceMin: '100000' });
    expect(a).toBe(`listings|types=${T1},${T2}&locations=${L}&priceMin=100000&sort=newest`);
    // No-op and canonical-equal parameters: the same signature.
    for (const same of [
      { types: `${T1}, ${T2} ,${T1}`, locations: L, priceMin: '0100000' },
      {
        types: `${T1},${T2}`,
        locations: L.toUpperCase(),
        priceMin: '100000',
        limit: '100',
        lang: 'es',
        facets: 'beds',
      },
      { types: `${T1},${T2}`, locations: L, priceMin: '100000', sort: 'newest', _k: 'a'.repeat(22) },
    ]) {
      expect(sliceSignature('listings', same)).toBe(a);
    }
    // Junk parameters cannot inflate the count: the strict schema refuses the request (400), so it has no signature.
    for (const junk of [{ _: '1700000000' }, { utm_source: 'x' }, { zz: '1' }]) {
      expect(sliceSignature('listings', { types: T1, ...junk })).toBeUndefined();
    }
    // Another band or another sort is another slice; the box keeps its order (north,west,south,east).
    expect(sliceSignature('listings', { types: `${T1},${T2}`, locations: L, priceMin: '200000' })).not.toBe(a);
    expect(
      sliceSignature('listings', { types: `${T1},${T2}`, locations: L, priceMin: '100000', sort: 'price_asc' }),
    ).toBe(`listings|types=${T1},${T2}&locations=${L}&priceMin=100000&sort=price_asc`);
    expect(sliceSignature('listings', { bbox: '37,-5,36,-4' })).toBe('listings|bbox=37,-5,36,-4&sort=newest');
    expect(sliceSignature('listings', { q: 'Sea VIEW ' })).toBe('listings|q=sea view&sort=newest');
    // No filter: an unfiltered first page slices nothing (whatever its sort).
    expect(sliceSignature('listings', { limit: '24', sort: 'price_asc', facets: 'beds' })).toBeUndefined();
    expect(sliceSignature('listings', undefined)).toBeUndefined();
    // Developments: by location, their own namespace.
    expect(sliceSignature('developments', { locations: L, limit: '10' })).toBe(`developments|locations=${L}`);
    expect(sliceSignature('developments', {})).toBeUndefined();
  });

  it('[S7-F7] filter-slicing: distinct filtered first pages flag and throttle a browser; key-wide they only alert', () => {
    expect(names(widget, { filterSignature: 'types=a' }).slice(-3)).toEqual([
      'feed.slice.browser.flag:flag',
      'feed.slice.browser:throttle',
      'feed.slice.key.standard:observe',
    ]);
    // A secret key's volume never flags it: key-wide alert only.
    expect(names(secret, { filterSignature: 'types=a' }).at(-1)).toBe('feed.slice.key.standard:observe');
    expect(names(secret, { filterSignature: 'types=a' }).some((n) => n.startsWith('feed.slice.browser'))).toBe(false);
    const checks = websiteRequestChecks(widget, { ip: facts.ip, paged: false, filterSignature: 'types=a' });
    for (const c of checks.filter((x) => x.rule.name.startsWith('feed.slice.'))) {
      expect(c.distinct).toBe('types=a');
      expect(c.rule).toMatchObject({ fixedWindow: true, windowSeconds: 3_600, penaltySeconds: 3_600 });
    }
    expect(checks.find((c) => c.rule.name === 'feed.slice.browser.flag')).toMatchObject({
      identity: `${widget.keyId}|${facts.ip}`,
      rule: { limit: 150 },
    });
  });

  it('[S7-F7] detail / sitemap sync: per browser flag and throttle, key-wide alert; only a secret key has a change-feed credit', () => {
    expect(names(widget, { sync: true }).slice(-3)).toEqual([
      'feed.sync.browser.flag:flag',
      'feed.sync.browser:throttle',
      'feed.sync.key.standard:observe',
    ]);
    expect(names(secret, { sync: true }).at(-1)).toBe('feed.sync.key.standard:observe');
    const widgetChecks = websiteRequestChecks(widget, { ip: facts.ip, paged: false, sync: true });
    expect(widgetChecks.filter((c) => c.creditPool !== undefined)).toEqual([]);
    const secretSync = websiteRequestChecks(secret, { ip: facts.ip, paged: false, sync: true }).at(-1);
    expect(secretSync).toMatchObject({ identity: secret.keyId, creditPool: SYNC_CREDIT_POOL });
  });

  it('[S7-F7] change-feed credit: secret keys only, one item per UPSERT (reference and change time)', async () => {
    const granted: { pool: string; identity: string; items: readonly string[]; slot?: string }[] = [];
    const limiter = {
      credit: async (pool: string, identity: string, items: readonly string[], o: { slot?: string }) => {
        granted.push({ pool, identity, items, slot: o.slot });
        return items.length;
      },
    } as unknown as RateLimiter;
    const page = [
      { ref: 'SS-1', change: 'UPSERT', changedAt: '2026-10-21T10:00:00.000Z' },
      { ref: 'SS-2', change: 'REMOVE', changedAt: '2026-10-21T10:00:01.000Z' },
      { ref: 'SS-3', change: 'UPSERT', changedAt: '2026-10-21T10:00:02.000Z' },
    ];
    expect(await creditChangeFeed(limiter, widget, page)).toBe(0);
    expect(await creditChangeFeed(limiter, secret, [])).toBe(0);
    expect(await creditChangeFeed(limiter, secret, page)).toBe(2);
    expect(granted).toEqual([
      {
        pool: SYNC_CREDIT_POOL,
        identity: secret.keyId,
        items: ['SS-1|2026-10-21T10:00:00.000Z', 'SS-3|2026-10-21T10:00:02.000Z'],
        slot: secret.agencyId,
      },
    ]);
  });

  it('[S7-F7] the agency day is keyed by the agency: enforced and counted last for secret keys, alert only for publishable ones', async () => {
    const day = websiteRequestChecks(secret, { ip: facts.ip, paged: false }).find(
      (c) => c.rule.name === 'feed.agency.quota',
    );
    expect(day).toMatchObject({
      identity: secret.agencyId,
      role: 'quota',
      rule: { scope: 'tenant', windowSeconds: 86_400, fixedWindow: true, limit: 2_000_000 },
    });
    // Another key of the agency (rotated or new) counts against the same identity.
    const other = { ...secret, keyId: '01900000-0000-7000-8000-000000000009' };
    expect(
      websiteRequestChecks(other, { ip: facts.ip, paged: false }).find(
        (c) => c.role === 'quota' && c.rule.scope === 'tenant',
      )?.identity,
    ).toBe(secret.agencyId);
    const midnight = Date.UTC(2026, 9, 22);
    const refused = await checkWebsiteLimits(
      scripted({ 'feed.agency.quota': { allowed: false, remaining: 0, retryAfterSeconds: 60, resetAtMs: midnight } }),
      secret,
      { ...facts, paged: false },
    );
    expect(refused).toMatchObject({ allowed: false, kind: 'quota', scope: 'tenant', resetAtMs: midnight });
    const seen: { checks: RateLimitCheck[] }[] = [];
    await checkWebsiteLimits(scripted({}, seen), secret, { ...facts, paged: false });
    expect(seen[0]?.checks.find((c) => c.rule.name === 'feed.agency.quota')).toMatchObject({ countLast: true });
    // Publishable keys: their own agency-wide counter, alert only.
    const observed = await checkWebsiteLimits(
      scripted({ 'feed.agency.pk.day': { allowed: false, remaining: 0, retryAfterSeconds: 60, tripped: true } }),
      widget,
      { ...facts, paged: false },
    );
    expect(observed).toEqual({ allowed: true, suspicious: false });
    expect(alerts).toEqual([
      expect.objectContaining({ action: 'observed', scope: 'agency', rule: 'feed.agency.pk.day' }),
    ]);
  });

  it('[S7-F7] a tripped slicing or sync flag alerts (and throttles past its limit); key-wide budgets only alert', async () => {
    const trip = { allowed: false, remaining: 0, retryAfterSeconds: 3_600, tripped: true };
    expect(
      await checkWebsiteLimits(scripted({ 'feed.slice.browser.flag': trip }), widget, {
        ...facts,
        paged: false,
        filterSignature: 'types=a',
      }),
      // Alerted; suspicious on its paged requests (peeks), not on this first page.
    ).toEqual({ allowed: true, suspicious: false });
    expect(
      await checkWebsiteLimits(scripted({ 'feed.sync.browser': trip }), widget, { ...facts, paged: false, sync: true }),
    ).toMatchObject({ allowed: false, kind: 'rate', scope: 'ip' });
    expect(
      await checkWebsiteLimits(scripted({ 'feed.slice.key.standard': trip }), secret, {
        ...facts,
        paged: false,
        filterSignature: 'types=a',
      }),
    ).toEqual({ allowed: true, suspicious: false });
    expect(alerts.map((a) => (a.kind === 'scraping' ? `${a.rule}:${a.action}:${a.scope}` : a.kind))).toEqual([
      'feed.slice.browser.flag:flagged:browser',
      'feed.sync.browser:throttled:browser',
      'feed.slice.key.standard:observed:key',
    ]);
    // Sent to the limiter with what it counts.
    const seen: { checks: RateLimitCheck[] }[] = [];
    await checkWebsiteLimits(scripted({}, seen), widget, {
      ...facts,
      paged: false,
      filterSignature: 'types=a',
      sync: true,
    });
    const sent = Object.fromEntries((seen[0]?.checks ?? []).map((c) => [c.rule.name, c]));
    expect(sent['feed.slice.browser']).toMatchObject({ distinct: 'types=a', observe: false });
    expect(sent['feed.slice.key.standard']).toMatchObject({ distinct: 'types=a', observe: true });
    expect(sent['feed.sync.browser.flag']).toMatchObject({ observe: true });
    expect(sent['feed.sync.browser.flag']?.creditPool).toBeUndefined();
  });

  it('[S7-F7] a browser flagged for slicing or sync is suspicious on its paged requests (peeks), never on a first page', async () => {
    const paged = websiteRequestChecks(widget, { ip: facts.ip, paged: true });
    const peeks = paged.filter((c) => c.peek === true);
    expect(peeks.map((c) => `${c.rule.name}:${c.role}`)).toEqual([
      'feed.slice.browser.flag:flag',
      'feed.sync.browser.flag:flag',
    ]);
    // The same rule (name, scope, identity, penalty) as the counting one, so the same penalty key.
    const slicing = websiteRequestChecks(widget, { ip: facts.ip, paged: false, filterSignature: 'x' }).find(
      (c) => c.rule.name === 'feed.slice.browser.flag',
    );
    expect(peeks[0]?.rule).toEqual(slicing?.rule);
    expect(peeks[0]?.identity).toBe(slicing?.identity);
    // Secret keys have no browser flags to peek at.
    expect(websiteRequestChecks(secret, { ip: facts.ip, paged: true }).some((c) => c.peek)).toBe(false);
    const penalized = { allowed: false, remaining: 0, retryAfterSeconds: 99, penalized: true };
    expect(await checkWebsiteLimits(scripted({ 'feed.slice.browser.flag': penalized }), widget, facts)).toEqual({
      allowed: true,
      suspicious: true,
    });
    // A first page (not paged) never becomes suspicious: it is the key's shared answer (S7-06).
    expect(
      await checkWebsiteLimits(scripted({ 'feed.slice.browser.flag': penalized }), widget, {
        ...facts,
        paged: false,
        filterSignature: 'x',
      }),
    ).toEqual({ allowed: true, suspicious: false });
    expect(alerts).toEqual([]);
  });
});

const SITE = { siteId: '01900000-0000-7000-8000-0000000000b1', referencePrefix: 'CH' };
const taxon = (name: string) => ({ id: '01900000-0000-7000-8000-00000000c0de', name, slug: name.toLowerCase() });

function card(i: number, over: Partial<WebsiteListingCard> = {}): WebsiteListingCard {
  return WebsiteListingCard.parse({
    kind: 'LISTING',
    id: `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    ref: `CH-${String(i).padStart(4, '0')}ABCD`.slice(0, 11),
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 45_000_000 + i * 1_000_000, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa'),
    place: { country: taxon('Spain'), region: null, city: taxon('Marbella'), area: null },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 180,
    plotM2: 900,
    geo: { lat: 36.51, lng: -4.88, precision: 'APPROX' },
    cover: null,
    imageCount: 12,
    developmentId: null,
    title: `Villa with sea views ${i}`,
    slug: `villa-with-sea-views-${i}`,
    textLocale: null,
    developmentRef: null,
    ...over,
  });
}

describe('honeytokens (S7-04)', () => {
  it('[S7-04] codes are per site, recognisable from the reference alone, and look like public codes', () => {
    const code = honeytokenCode(KEY, SITE.siteId, 'CH-0001ABCD');
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(honeytokenCode(KEY, SITE.siteId, 'CH-0001ABCD')).toBe(code);
    expect(isHoneytokenCode(KEY, SITE.siteId, code)).toBe(true);
    expect(isHoneytokenCode(KEY, '01900000-0000-7000-8000-0000000000b2', code)).toBe(false);
    expect(isHoneytokenRef(KEY, SITE, `CH-${code}`)).toBe(true);
    expect(isHoneytokenRef(KEY, SITE, `ch-${code.toLowerCase()}`)).toBe(true);
    expect(isHoneytokenRef(KEY, SITE, `XX-${code}`)).toBe(false);
    expect(isHoneytokenRef(KEY, SITE, code)).toBe(false);
    expect(honeytokenSiteOf(KEY, ['01900000-0000-7000-8000-0000000000b2', SITE.siteId], code)).toBe(SITE.siteId);
    // Real (random) codes are almost never taken for one: the check half is 20 bits.
    let false_ = 0;
    for (let i = 0; i < 5_000; i++) {
      const random = Array.from(
        { length: 8 },
        (_, j) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[(i * 7 + j * 13 + i * j) % 32],
      ).join('');
      if (isHoneytokenCode(KEY, SITE.siteId, random)) false_++;
    }
    expect(false_).toBeLessThanOrEqual(1);
  });

  it('[S7-04] a honeytoken is a white-label-safe clone: strict card, only what the page already shows, its own id and reference', () => {
    const real = card(1, { cover: null });
    const token = honeytokenCard(KEY, SITE, real);
    expect(WebsiteListingCard.parse(token)).toEqual(token);
    expect(token.id).not.toBe(real.id);
    expect(token.ref).toMatch(/^CH-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(token.ref).not.toBe(real.ref);
    // Texts, place and type come from the card the site already serves (white-labelled by the serializer).
    expect({ title: token.title, slug: token.slug, place: token.place, type: token.propertyType }).toEqual({
      title: real.title,
      slug: real.slug,
      place: real.place,
      type: real.propertyType,
    });
    expect(Object.keys(token).sort()).toEqual(Object.keys(real).sort());
    // Facts are shifted, never near-copies: 2–9 % on the price, 2–8 % on sizes, a different point.
    const realPrice = real.price.amountCents as number;
    const shift = Math.abs((token.price.amountCents as number) - realPrice) / realPrice;
    expect(shift).toBeGreaterThan(0.01);
    expect(shift).toBeLessThanOrEqual(0.1);
    expect((token.price.amountCents as number) % 100_000).toBe(0);
    expect(token.builtM2).not.toBe(real.builtM2);
    expect(token.geo).not.toEqual(real.geo);
    // The same real card always gives the same honeytoken.
    expect(honeytokenCard(KEY, SITE, real)).toEqual(token);
  });

  it('[S7-04] on an own card the honeytoken keeps the agency’s reference style, recognisable by its check digits', () => {
    const own = card(5, { ref: 'R4123456' });
    const token = honeytokenCard(KEY, SITE, own);
    expect(token.ref).toMatch(/^R\d{7}$/);
    expect(token.ref).not.toBe(own.ref);
    expect(honeytokenKind(KEY, SITE, token.ref)).toEqual({ style: 'own' });
    expect(honeytokenKind(KEY, SITE, own.ref)).toBeNull();
    // Too few digits to carry a check: the network style instead.
    expect(honeytokenCard(KEY, SITE, card(6, { ref: 'VILLA-12' })).ref).toMatch(/^CH-[0-9A-HJKMNP-TV-Z]{8}$/);
    // A code-style one says which code to confirm against the real ones.
    const coded = honeytokenCard(KEY, SITE, card(7)).ref;
    expect(honeytokenKind(KEY, SITE, coded)).toEqual({ style: 'code', code: coded.slice(3) });
  });

  it('[S7-04] pages: one card replaced by its own clone (the page keeps its size), the same for the same cursor', () => {
    const items: WebsiteCard[] = [card(1), card(2), card(3)];
    const page = withHoneytoken(KEY, SITE, 'cursor-a', items);
    expect(page).toHaveLength(3);
    const replaced = items.findIndex((c, i) => page[i] !== c);
    const token = page[replaced] as WebsiteListingCard;
    expect(isHoneytokenRef(KEY, SITE, token.ref)).toBe(true);
    // Cloned from the card it replaced: no near-duplicate of it left on the page.
    expect(token.title).toBe((items[replaced] as WebsiteListingCard).title);
    expect(page.filter((c) => c.title === token.title)).toHaveLength(1);
    expect(withHoneytoken(KEY, SITE, 'cursor-a', items)).toEqual(page);
    // Cards inside developments are never cloned.
    const inDevelopment = [card(4, { developmentId: '01900000-0000-7000-8000-0000000000d1' })];
    expect(withHoneytoken(KEY, SITE, 'cursor-b', inDevelopment)).toBe(inDevelopment);
    expect(withHoneytoken(KEY, SITE, 'cursor-b', [])).toEqual([]);
  });
});
