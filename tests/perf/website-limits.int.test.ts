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

it('[S7-04] exactly one Redis call and no database statement per request; Redis memory per browser', async () => {
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
  expect(scriptCalls).toBe(N);
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
    `[S7-04] per request: ${scriptCalls / N} Redis call(s), ${statements} DB statements; per browser: ${JSON.stringify(perBrowser)}`,
  );
  expect(perBrowser.keys).toBeLessThanOrEqual(5);
  expect(perBrowser.bytes).toBeLessThan(1_000);
});
