import * as identity from '@inmolink/core/modules/identity';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { countQueries } from '@inmolink/db';
import { loadStackEnv } from '@inmolink/db/testing';
import { createLogger } from '@inmolink/platform/logger';
import {
  closeRateLimit,
  configureRateLimit,
  type RateLimitCheck,
  RateLimiter,
  rateLimitConnection,
} from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * What S7-04's quota and anti-scraping checks add to a website API request (CLAUDE.md: the checks are Redis round
 * trips, never database statements). Measured on the limits Redis of the `test` stack: S7-03's two rules (tier +
 * agency, two script calls at once) against S7-04's full set in one script call (`consumeMany`) for a secret key's paged
 * request (5 rules) and a publishable key's (8 rules). Numbers are printed for the STATUS entry.
 */

const RUNS = 1_000;
const prefix = `t:rl:perf:${Date.now().toString(36)}`;
let limiter: RateLimiter;

const key = (kind: 'SECRET' | 'PUBLISHABLE', i: number): identity.ApiKeyPrincipal => ({
  keyId: `perf-${kind}-${i % 50}`,
  agencyId: `perf-agency-${i % 10}`,
  kind,
  scopes: ['listings:read'],
  rateTier: 'HIGH',
  siteId: SITE,
  legacyQueryKey: false,
});
const SITE = '01900000-0000-7000-8000-00000000fe01';

beforeAll(async () => {
  loadStackEnv('test');
  await configureRateLimit({ commandTimeoutMs: 5_000 });
  limiter = new RateLimiter({
    redis: rateLimitConnection(),
    prefix,
    logger: createLogger({ level: 'silent' }),
    hmacKey: 'perf-rate-limit-hmac-key-0123456789abcdef',
  });
  // Nothing trips: the measurement is the allowed path every real request takes.
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'perf-cursor-key-0123456789abcdef0123',
    limits: {
      dailyQuota: { STANDARD: 1e9, HIGH: 1e9 },
      burst: { STANDARD: 1e9, HIGH: 1e9 },
      browserPerMinute: 1e9,
      browserBurst: 1e9,
      browserPerDay: 1e9,
      pagingPerKeyHour: { STANDARD: 1e9, HIGH: 1e9 },
      browserPagingFlag: 1e9,
      browserPagingLimit: 1e9,
      deepPerHour: 1e9,
    },
  });
});

afterAll(async () => {
  const redis = rateLimitConnection();
  const keys = await redis.keys(`${prefix}:*`);
  for (let i = 0; i < keys.length; i += 500) await redis.del(...keys.slice(i, i + 500));
  await closeRateLimit();
});

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};

async function measure(fn: (i: number) => Promise<unknown>) {
  for (let i = 0; i < 50; i++) await fn(i); // warm up (script load, connection)
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await fn(i);
    ms.push(performance.now() - t);
  }
  return { p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99) };
}

it('[S7-04] quota and anti-scraping checks add one Redis round trip, no database statement', async () => {
  // Raise the per-minute rules out of the way for this test (the HIGH tier: 3,000 / min per key, 50 keys).
  const s703 = await measure((i) =>
    Promise.all([
      limiter.consume({ ...identity.apiKeyRateRule('HIGH'), limit: 1e9 }, key('SECRET', i).keyId),
      limiter.consume({ ...identity.API_KEY_AGENCY_RULE, limit: 1e9 }, key('SECRET', i).agencyId),
    ]),
  );
  const unlimited = {
    consumeMany: (checks: readonly RateLimitCheck[]) =>
      limiter.consumeMany(
        checks.map((c) =>
          c.rule.name.startsWith('feed.key') || c.rule.name === 'feed.agency'
            ? { ...c, rule: { ...c.rule, limit: 1e9 } }
            : c,
        ),
      ),
  } as RateLimiter;
  // A secret key's deep page (the most rules a secret key gets: tier, agency, burst, quota, deep flag, deep throttle).
  const deepCursor = websiteApi.searchCursorFor(SITE, 60, 'inner-cursor');
  const secretPaged = await measure((i) =>
    websiteApi.checkWebsiteLimits(unlimited, key('SECRET', i), {
      ip: `198.51.100.${i % 200}`,
      paged: true,
      listingsCursor: deepCursor,
      requestId: 'perf',
    }),
  );
  const publishablePaged = await measure((i) =>
    websiteApi.checkWebsiteLimits(unlimited, key('PUBLISHABLE', i), {
      ip: `198.51.100.${i % 200}`,
      paged: true,
      requestId: 'perf',
    }),
  );
  const report = { s703, secretPaged, publishablePaged };
  console.info(`[S7-04] limit checks (ms): ${JSON.stringify(report)}`);
  // One round trip for all rules: a few hundred microseconds more than S7-03's two rules, never milliseconds.
  expect(publishablePaged.p95).toBeLessThan(s703.p95 + 3);
  expect(publishablePaged.p95).toBeLessThan(10);
});

/** Calls of each Redis command so far (`INFO commandstats`). */
async function commandCalls(): Promise<Record<string, number>> {
  const info = (await rateLimitConnection().info('commandstats')) as string;
  const out: Record<string, number> = {};
  for (const m of info.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)) out[m[1] as string] = Number(m[2]);
  return out;
}

it('[S7-04] one Redis call per limit slot and no database statement per request (publishable: two, the per-IP rule in its own slot since S7-F9; secret: one); Redis memory per browser', async () => {
  const N = 200;
  const widget = key('PUBLISHABLE', 7);
  // Its own key prefix, so only this test's browsers are counted.
  const own = new RateLimiter({
    redis: rateLimitConnection(),
    prefix: `${prefix}:mem`,
    logger: createLogger({ level: 'silent' }),
    hmacKey: 'perf-rate-limit-hmac-key-0123456789abcdef',
  });
  const facts = (i: number) => ({ ip: `203.0.113.${i}`, paged: true, requestId: 'perf' });
  await websiteApi.checkWebsiteLimits(own, widget, facts(0)); // the script is loaded
  const before = await commandCalls();
  let statements = 0;
  for (let i = 1; i <= N; i++) {
    statements += await countQueries(() => websiteApi.checkWebsiteLimits(own, widget, facts(i)));
  }
  const after = await commandCalls();
  const scriptCalls = (after.evalsha ?? 0) - (before.evalsha ?? 0) + ((after.eval ?? 0) - (before.eval ?? 0));
  expect(statements).toBe(0);
  // Publishable keys: the key/browser rules and the `feed.pk.ip` rule (its own slot) are two script calls.
  expect(scriptCalls).toBe(2 * N);
  // A secret key has no per-IP slot: exactly one call.
  const secret = key('SECRET', 7);
  await websiteApi.checkWebsiteLimits(own, secret, facts(0));
  const beforeSecret = await commandCalls();
  await websiteApi.checkWebsiteLimits(own, secret, facts(1));
  const afterSecret = await commandCalls();
  expect(
    (afterSecret.evalsha ?? 0) - (beforeSecret.evalsha ?? 0) + ((afterSecret.eval ?? 0) - (beforeSecret.eval ?? 0)),
  ).toBe(1);
  // What one browser (key × IP) leaves in the limits Redis: its per-browser rules' keys.
  const redis = rateLimitConnection();
  const browserKeys = (await redis.keys(`${prefix}:mem:*`)).filter((k) =>
    /:feed\.(browser|paging\.browser)[^:]*:ip:/.test(k),
  );
  const sample = browserKeys.slice(0, 200);
  const bytes = (await Promise.all(sample.map((k) => redis.memory('USAGE', k)))).reduce<number>(
    (a, b) => a + Number(b ?? 0),
    0,
  );
  const perBrowser = {
    keys: browserKeys.length / (N + 1),
    bytes: Math.round((bytes / sample.length) * (browserKeys.length / (N + 1))),
  };
  console.info(
    `[S7-04] per publishable request: ${scriptCalls / N} Redis call(s), ${statements} DB statements; per browser: ${JSON.stringify(perBrowser)}`,
  );
  expect(perBrowser.keys).toBeLessThanOrEqual(5);
  expect(perBrowser.bytes).toBeLessThan(1_000);
});

it('[S7-F7] extraction budgets add no call (two per publishable request, one per limit slot): filtered first pages and details, no statement; memory per browser and key', async () => {
  const N = 200;
  const own = new RateLimiter({
    redis: rateLimitConnection(),
    prefix: `${prefix}:f7`,
    logger: createLogger({ level: 'silent' }),
    hmacKey: 'perf-rate-limit-hmac-key-0123456789abcdef',
  });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'perf-cursor-key-0123456789abcdef0123',
    limits: {
      dailyQuota: { STANDARD: 1e9, HIGH: 1e9 },
      burst: { STANDARD: 1e9, HIGH: 1e9 },
      browserPerMinute: 1e9,
      browserBurst: 1e9,
      browserPerDay: 1e9,
      sliceBrowserFlag: 1e9,
      sliceBrowserLimit: 1e9,
      slicePerKey: { STANDARD: 1e9, HIGH: 1e9 },
      syncBrowserFlag: 1e9,
      syncBrowserLimit: 1e9,
      syncPerKey: { STANDARD: 1e9, HIGH: 1e9 },
      agencyDailyQuota: 1e9,
    },
  });
  const unlimited = {
    consumeMany: (checks: readonly RateLimitCheck[], options?: { slot?: string }) =>
      own.consumeMany(
        checks.map((c) =>
          c.rule.name.startsWith('feed.key') || c.rule.name === 'feed.agency'
            ? { ...c, rule: { ...c.rule, limit: 1e9 } }
            : c,
        ),
        options,
      ),
  } as RateLimiter;
  const widget = key('PUBLISHABLE', 3);
  // A visitor: ten filtered searches (two repeated) and twenty details.
  const visitor = async (ip: string, i: number) => {
    for (let s = 0; s < 10; s++) {
      await websiteApi.checkWebsiteLimits(unlimited, widget, {
        ip,
        paged: false,
        filterSignature: `pricemin=${(s % 8) * 100_000}&types=${i % 3}`,
        requestId: 'perf',
      });
    }
    for (let d = 0; d < 20; d++) {
      await websiteApi.checkWebsiteLimits(unlimited, widget, { ip, paged: false, sync: true, requestId: 'perf' });
    }
  };
  await visitor('192.0.2.250', 0); // the script is loaded
  const before = await commandCalls();
  let statements = 0;
  for (let i = 0; i < N; i++) statements += await countQueries(() => visitor(`192.0.2.${i}`, i));
  const after = await commandCalls();
  const scriptCalls = (after.evalsha ?? 0) - (before.evalsha ?? 0) + ((after.eval ?? 0) - (before.eval ?? 0));
  expect(statements).toBe(0);
  expect(scriptCalls).toBe(N * 30 * 2); // two slots per publishable request

  // What one browser adds for slicing and sync, and one busy key's slicing HyperLogLog.
  const redis = rateLimitConnection();
  const usage = async (pattern: RegExp) => {
    const keys = (await redis.keys(`${prefix}:f7:*`)).filter((k) => pattern.test(k));
    const bytes = (await Promise.all(keys.map((k) => redis.memory('USAGE', k)))).reduce<number>(
      (a, b) => a + Number(b ?? 0),
      0,
    );
    const each = await Promise.all(keys.map((k) => redis.memory('USAGE', k)));
    return { keys: keys.length, bytes, max: Math.max(0, ...each.map((b) => Number(b ?? 0))) };
  };
  // Measured before the latency runs below, which add browsers of other keys.
  const browsers = N + 1;
  const slice = await usage(/:u:ip:/); // the browser's slicing HyperLogLog (flag and throttle share it)
  const sync = await usage(/:feed\.sync\.browser[^:]*:ip:/);
  const perBrowser = {
    keys: (slice.keys + sync.keys) / browsers,
    bytes: Math.round((slice.bytes + sync.bytes) / browsers),
  };
  const sliced = await measure((i) =>
    websiteApi.checkWebsiteLimits(unlimited, key('PUBLISHABLE', i), {
      ip: `198.51.100.${i % 200}`,
      paged: false,
      filterSignature: `pricemin=${i}`,
      requestId: 'perf',
    }),
  );
  const detail = await measure((i) =>
    websiteApi.checkWebsiteLimits(unlimited, key('PUBLISHABLE', i), {
      ip: `198.51.100.${i % 200}`,
      paged: false,
      sync: true,
      requestId: 'perf',
    }),
  );

  // Last: 20k writes to one key can set off an AOF rewrite that would stall the latency runs above.
  const busy = key('SECRET', 1);
  for (let i = 0; i < 20_000; i += 200) {
    await Promise.all(
      Array.from({ length: 200 }, (_, j) =>
        websiteApi.checkWebsiteLimits(unlimited, busy, {
          ip: '198.51.100.1',
          paged: false,
          filterSignature: `slice=${i + j}`,
          requestId: 'perf',
        }),
      ),
    );
  }
  const keyHll = await usage(/:u:key:/);
  console.info(
    `[S7-F7] limit checks (ms): ${JSON.stringify({ sliced, detail })}; per request ${scriptCalls / (N * 30)} Redis call(s), ${statements} DB statements; per browser (10 searches, 20 details): ${JSON.stringify(perBrowser)}; busiest key's slicing HLL (20k distinct): ${JSON.stringify(keyHll)}`,
  );
  expect(sliced.p95).toBeLessThan(10);
  expect(detail.p95).toBeLessThan(10);
  // One HyperLogLog (shared by the slicing flag and throttle) and the two sync rules' window keys.
  expect(perBrowser.keys).toBeLessThanOrEqual(3);
  expect(perBrowser.bytes).toBeLessThan(1_000);
  // However many slices a key sends, its HyperLogLog stays ≤ 12 KB (dense) plus Redis overhead.
  expect(keyHll.max).toBeLessThan(16_000);
}, 300_000);
