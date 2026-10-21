import { createHash } from 'node:crypto';
import {
  TaxonomyLangQuery,
  WebsiteChangesQuery,
  WebsiteLangQuery,
  WebsiteListingParams,
  WebsiteListingsQuery,
} from '@inmolink/contracts';
import * as search from '@inmolink/core/modules/search';
import { describe, expect, it } from 'vitest';
import { edgeKeyToken } from '../../apps/feed-api/src/plugins/api-key';
import { assertLoadTarget, loadKeyLimits } from '../../scripts/perf/load-sites';
import {
  CHANGE_LOG_RETENTION_DAYS,
  cumulative,
  detailRequest,
  edgeToken,
  KEY_HEADROOM,
  keysNeeded,
  MIX,
  maxKeyShare,
  nextPageQuery,
  otherRequest,
  PROFILES,
  pickWeighted,
  resolveProfile,
  type SitePool,
  SLO,
  type SummaryData,
  scenarios,
  searchRequest,
  siteWeights,
  startSession,
  summaryReport,
  summaryText,
  thresholds,
  withEdgeToken,
} from './lib/website-mix';

/** A seeded PRNG (mulberry32): the distributions below are checked on a fixed sample. */
const rngOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const pool: SitePool = {
  refs: ['LT1-7KQ2M9XA', 'CH-123', 'PF42'],
  locations: ['0195f0a5-0001-7000-8000-000000000001', '0195f0a5-0001-7000-8000-000000000002'],
  types: ['0195f0a5-0005-7000-8000-000000000001'],
  langs: ['en', 'es', 'de'],
  pages: [nextPageQuery('sort=price_asc&limit=24', '001abcdefghijkeyJzIjoicHJpY2VfYXNjIn0')],
  changeCursors: ['eyJ4IjoxfQ'],
  points: [[36.51, -4.88]],
};

const query = (path: string) => Object.fromEntries(new URL(path, 'http://x').searchParams);

describe('website API load test (S7-08)', () => {
  it('[S7-08] scenario mix: search 60 %, detail 30 %, taxonomy and changes 10 % of the target rate', () => {
    expect(MIX).toEqual({ search: 0.6, detail: 0.3, other: 0.1 });
    const s = scenarios(PROFILES.staging);
    expect(s.search).toMatchObject({ executor: 'constant-arrival-rate', exec: 'search', rate: 600, duration: '900s' });
    expect(s.detail).toMatchObject({ rate: 300, exec: 'detail' });
    expect(s.other).toMatchObject({ rate: 100, exec: 'other' });
    // The warm-up ramp runs first and is not judged; the steady scenarios start when it ends.
    expect(s.warmup).toMatchObject({ executor: 'ramping-arrival-rate', exec: 'mixed', tags: { phase: 'warmup' } });
    for (const name of ['search', 'detail', 'other']) {
      expect(s[name]).toMatchObject({ startTime: '120s', tags: { phase: 'steady' } });
    }
    // The other half of the 10 %: taxonomy and the change feed, about evenly.
    const rng = rngOf(7);
    const endpoints = Array.from({ length: 4_000 }, () => otherRequest(rng, pool, Date.now()).endpoint);
    const taxonomy = endpoints.filter((e) => e === 'taxonomy').length / endpoints.length;
    expect(taxonomy).toBeGreaterThan(0.45);
    expect(taxonomy).toBeLessThan(0.55);
  });

  it('[S7-08] thresholds encode the acceptance check: 1,000 rps origin for 15 min, p95 < 150 ms, errors < 0.1 %', () => {
    const p = PROFILES.staging;
    expect(p).toMatchObject({ rate: 1_000, seconds: 900, edge: false });
    expect(SLO).toMatchObject({ rps: 1_000, seconds: 900, p95Ms: 150, errorRate: 0.001 });
    const t = thresholds(p);
    expect(t['http_req_duration{phase:steady}']).toEqual(['p(95)<150']);
    expect(t['http_req_failed{phase:steady}']).toEqual(['rate<0.001']);
    // Sustained: at least 99 % of the 900,000 planned requests sent in the steady phase, ≤ 1 % dropped.
    expect(t['http_reqs{phase:steady}']).toEqual(['count>=891000']);
    expect(t['dropped_iterations{phase:steady}']).toEqual(['count<=9000']);
    for (const s of ['search', 'detail', 'other']) expect(t[`http_req_duration{scenario:${s}}`]).toEqual(['p(95)<150']);
    expect(t['http_req_duration{phase:steady,endpoint:search_cursor}']).toEqual(['p(95)<150']);
    // The smoke run keeps the same budgets at its own rate; env overrides reach the profile.
    const smoke = resolveProfile({ PROFILE: 'smoke', RATE: '30', DURATION: '60' });
    expect(smoke).toMatchObject({ rate: 30, seconds: 60, p95Ms: 150, edge: false });
    expect(resolveProfile({ PROFILE: 'spike' })).toMatchObject({ rate: 2_000, edge: true });
    expect(() => resolveProfile({ PROFILE: 'production' })).toThrow(/PROFILE/);
    // The acceptance profile takes no overrides (review), and other runs say they are not it.
    expect(() => resolveProfile({ PROFILE: 'staging', RATE: '500' })).toThrow(/acceptance check: no RATE/);
    expect(() => resolveProfile({ PROFILE: 'staging', P95_MS: '400' })).toThrow(/P95_MS/);
    expect(resolveProfile({ PROFILE: 'staging' })).toMatchObject({ rate: 1_000, seconds: 900 });
    const empty = { metrics: {} };
    expect(summaryText(empty, PROFILES.staging)).toContain('(the acceptance profile)');
    expect(summaryText(empty, smoke)).toContain('NOT the acceptance profile');
  });

  it('[S7-08] load-test keys are enough that no limit trips at the target rate (no bypass)', () => {
    const limits = loadKeyLimits();
    expect(limits).toMatchObject({ perKeyPerMinute: 3_000, agencyPerMinute: 3_000, burst: 500, dailyQuota: 1_000_000 });
    const seconds = PROFILES.staging.seconds + PROFILES.staging.warmupSeconds;
    const n = keysNeeded(SLO.rps, seconds, limits);
    expect(n).toBe(25);
    const perKey = SLO.rps / n;
    expect(perKey * 60).toBeLessThanOrEqual(KEY_HEADROOM * limits.perKeyPerMinute);
    expect(perKey * 60).toBeLessThanOrEqual(KEY_HEADROOM * limits.agencyPerMinute);
    expect(perKey * limits.burstWindowSeconds).toBeLessThanOrEqual(KEY_HEADROOM * limits.burst);
    expect(perKey * seconds).toBeLessThanOrEqual(KEY_HEADROOM * limits.dailyQuota);
    // A day-long soak at half the rate is bound by the daily quota instead.
    expect(keysNeeded(500, 86_400, limits)).toBe(Math.ceil((500 * 86_400) / (0.8 * 1_000_000)));
  });

  it('[S7-08] load-test keys are never created in production', () => {
    expect(() => assertLoadTarget({ NODE_ENV: 'test' }, false)).not.toThrow();
    expect(() => assertLoadTarget({ NODE_ENV: 'production', DEPLOY_ENV: 'staging' }, true)).not.toThrow();
    expect(() => assertLoadTarget({ NODE_ENV: 'production', DEPLOY_ENV: 'staging' }, false)).toThrow(/--staging/);
    expect(() => assertLoadTarget({ NODE_ENV: 'production', DEPLOY_ENV: 'production' }, true)).toThrow(/production/);
    expect(() => assertLoadTarget({ NODE_ENV: 'production' }, true)).toThrow(/NODE_ENV=production/);
    expect(() => assertLoadTarget({ NODE_ENV: 'test', DEPLOY_ENV: 'production' }, false)).toThrow(/production/);
    // Only an explicit, known non-production environment (review): unset, unknown or misspelt values are refused.
    expect(() => assertLoadTarget({}, true)).toThrow(/neither/);
    expect(() => assertLoadTarget({ DEPLOY_ENV: 'prod' }, true)).toThrow(/DEPLOY_ENV=prod/);
    expect(() => assertLoadTarget({ NODE_ENV: 'staging' }, true)).toThrow(/NODE_ENV=staging/);
    expect(() => assertLoadTarget({ DEPLOY_ENV: 'staging' }, false)).toThrow(/--staging/);
    expect(() => assertLoadTarget({ DEPLOY_ENV: 'development' }, false)).not.toThrow();
  });

  it('[S7-08] sites are drawn Zipf-weighted, the busiest one capped below its key limits', () => {
    const limits = loadKeyLimits();
    const seconds = PROFILES.staging.seconds + PROFILES.staging.warmupSeconds;
    const share = maxKeyShare(SLO.rps, seconds, limits);
    const w = siteWeights(500, share);
    expect(w.reduce((t, x) => t + x, 0)).toBeCloseTo(1, 9);
    expect(Math.max(...w)).toBeLessThanOrEqual(share + 1e-12);
    // A long tail: the 250 quietest sites still get traffic, far less than the busiest.
    expect(w[499]).toBeGreaterThan(0);
    expect((w[0] as number) / (w[499] as number)).toBeGreaterThan(20);
    // At the cap, a key runs ≤ 80 % of its tier and burst.
    expect(SLO.rps * share * 60).toBeLessThanOrEqual(0.8 * limits.perKeyPerMinute + 1e-9);
    expect(() => siteWeights(10, share)).toThrow(/more sites/);
    const cum = cumulative(w);
    const rng = rngOf(3);
    const hits = new Array<number>(500).fill(0);
    for (let i = 0; i < 50_000; i++) {
      const k = pickWeighted(rng, cum);
      hits[k] = (hits[k] ?? 0) + 1;
    }
    expect((hits[0] as number) / 50_000).toBeGreaterThan(share * 0.4);
  });

  it('[S7-08] a VU follows its own search by `nextCursor` to a random depth; plugins catch up over the whole log', () => {
    const rng = rngOf(11);
    const first = searchRequest(() => 0.99, pool);
    expect(first.endpoint).toBe('search_first');
    const session = startSession(rng, first.query as string, 'abcDEF_-123');
    expect(session?.maxDepth).toBeGreaterThanOrEqual(2);
    expect(session?.maxDepth).toBeLessThanOrEqual(6);
    const next = searchRequest(() => 0, pool, session);
    expect(next).toMatchObject({ endpoint: 'search_cursor' });
    expect(next.path).toBe(`/v2/listings?${first.query}&cursor=abcDEF_-123`);
    expect(startSession(rng, 'sort=newest', null)).toBeUndefined();
    // `since` spans 5 minutes to the change log's retention, log-uniform.
    expect(CHANGE_LOG_RETENTION_DAYS).toBe(search.PUBLIC_CHANGES_RETENTION_DAYS);
    const now = Date.now();
    const ages: number[] = [];
    for (let i = 0; i < 4_000; i++) {
      const r = otherRequest(rng, { ...pool, changeCursors: [] }, now);
      if (r.endpoint !== 'changes_since') continue;
      ages.push((now - Date.parse(query(r.path).since as string)) / 86_400_000);
    }
    expect(Math.max(...ages)).toBeGreaterThan(20);
    expect(Math.max(...ages)).toBeLessThan(CHANGE_LOG_RETENTION_DAYS);
    expect(ages.filter((a) => a < 1).length / ages.length).toBeGreaterThan(0.4);
    // A VU's own change cursor for the site is continued.
    expect(otherRequest(() => 0.55, pool, now, 'own-cursor').path).toBe('/v2/changes?cursor=own-cursor');
  });

  it('[S7-08] every generated request is a valid website API v2 request, in visitor-like shares', () => {
    const rng = rngOf(42);
    const n = 5_000;
    const counts: Record<string, number> = {};
    let located = 0;
    for (let i = 0; i < n; i++) {
      const r = searchRequest(rng, pool);
      counts[r.endpoint] = (counts[r.endpoint] ?? 0) + 1;
      expect(r.path.startsWith('/v2/listings?')).toBe(true);
      const q = query(r.path);
      if (q.locations) located++;
      expect(WebsiteListingsQuery.safeParse(q).error?.issues, r.path).toBeUndefined();
    }
    // Pages 2+ about a quarter; map views about a tenth of the rest; filters on about half the first pages.
    expect((counts.search_cursor ?? 0) / n).toBeGreaterThan(0.2);
    expect((counts.search_cursor ?? 0) / n).toBeLessThan(0.3);
    expect((counts.search_map ?? 0) / n).toBeGreaterThan(0.05);
    expect(located / (counts.search_first ?? 1)).toBeGreaterThan(0.45);
    for (let i = 0; i < 500; i++) {
      const d = detailRequest(rng, pool);
      const url = new URL(d?.path ?? '', 'http://x');
      expect(
        WebsiteListingParams.safeParse({ ref: decodeURIComponent(url.pathname.split('/')[3] ?? '') }).success,
      ).toBe(true);
      expect(WebsiteLangQuery.safeParse(query(d?.path ?? '')).success).toBe(true);
      const o = otherRequest(rng, pool, Date.now());
      const schema = o.endpoint === 'taxonomy' ? TaxonomyLangQuery : WebsiteChangesQuery;
      expect(schema.safeParse(query(o.path)).success, o.path).toBe(true);
    }
    expect(detailRequest(rng, { ...pool, refs: [] })).toBeUndefined();
  });

  it("[S7-08] edge mode sends feed-api's own `_k` token (S7-06), so the edge path is measured apart from origin", () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
    for (const key of ['inl_test_sk123_abc', 'inl_staging_sk9_xyz']) {
      const k = edgeToken(key, '', sha);
      expect(k).toBe(edgeKeyToken(key));
      expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(withEdgeToken('/v2/listings?sort=newest', k)).toBe(`/v2/listings?sort=newest&_k=${k}`);
      expect(withEdgeToken('/v2/listings/CH-1', k)).toBe(`/v2/listings/CH-1?_k=${k}`);
      expect(WebsiteListingsQuery.safeParse(query(withEdgeToken('/v2/listings?sort=newest', k))).success).toBe(true);
    }
  });

  it('[S7-08] the summary reports the rate held, the error rate and p95 per scenario, and fails on a broken threshold', () => {
    const p = { ...PROFILES.smoke, rate: 20, seconds: 60 };
    const data: SummaryData = {
      metrics: {
        'http_reqs{phase:steady}': { values: { count: 1_200 } },
        'http_req_failed{phase:steady}': { values: { rate: 0 }, thresholds: { 'rate<0.001': { ok: true } } },
        'http_req_duration{phase:steady}': {
          values: { med: 12.34, 'p(95)': 48.06, 'p(99)': 90 },
          thresholds: { 'p(95)<150': { ok: true } },
        },
        'http_req_duration{scenario:search}': {
          values: { med: 20, 'p(95)': 160, 'p(99)': 200 },
          thresholds: { 'p(95)<150': { ok: false } },
        },
        dropped_iterations: { values: { count: 0 } },
      },
    };
    const r = summaryReport(data, p);
    expect(r).toMatchObject({ requests: 1_200, rps: 20, errorRate: 0, dropped: 0, pass: false });
    expect(r.failedThresholds).toEqual(['http_req_duration{scenario:search} p(95)<150']);
    expect(r.rows[0]).toEqual({ name: 'all (steady)', p50: 12.3, p95: 48.1, p99: 90 });
  });
});
