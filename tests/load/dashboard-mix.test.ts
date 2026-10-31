import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ListActivitiesQuery,
  ListCalendarEventsQuery,
  ListContactsQuery,
  ListLeadsQuery,
  ListListingsQuery,
  ListNotificationsQuery,
  ListTasksQuery,
  NETWORK_SEARCH_LIMIT_MAX,
  NetworkSearchBody,
  PipelineBoardQuery,
} from '@inmolink/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRefreshExposure,
  createLimiter,
  isLoopbackHost,
  type LoadMember,
  startTokenService,
  type TokenService,
} from '../../scripts/perf/load-tokens';
import {
  ACCEPTANCE_PROFILE,
  actionAt,
  ENDPOINTS,
  type Endpoint,
  MAX_PAGE_SIZE,
  MIX,
  minSteadyRequests,
  NETWORK_PAGE_MAX,
  newVuState,
  nextRequest,
  observe,
  officeAddress,
  PROFILES,
  phaseAt,
  type Req,
  refreshDue,
  requestFor,
  resolveProfile,
  SLO,
  type SummaryData,
  scenarios,
  summaryReport,
  summaryText,
  THINK_MEAN_SECONDS,
  thinkSeconds,
  thresholds,
  tokensLastProblem,
} from './lib/dashboard-mix';

/** A seeded PRNG (mulberry32): the distributions below are checked on a fixed sample. */
const rngOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const ROOT = join(import.meta.dirname, '..', '..');
const LISTING = '0195f0a5-0001-7000-8000-000000000001';
const CONTACT = '0195f0a5-0002-7000-8000-000000000001';
const NOW = Date.parse('2026-11-01T10:00:00Z');

/** Every route file of the dashboard API, concatenated (the routes the mix calls must exist, with that method). */
const routeSource = (() => {
  const dir = join(ROOT, 'apps', 'api', 'src', 'routes');
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
})();

/** The route each endpoint calls: method and Fastify pattern. */
const ROUTES: Record<Endpoint, [string, string]> = {
  listings_list: ['get', '/v1/listings'],
  listings_cursor: ['get', '/v1/listings'],
  listing_detail: ['get', '/v1/listings/:id'],
  contacts_list: ['get', '/v1/crm/contacts'],
  contacts_cursor: ['get', '/v1/crm/contacts'],
  contact_detail: ['get', '/v1/crm/contacts/:id'],
  contact_timeline: ['get', '/v1/crm/activities'],
  activities: ['get', '/v1/crm/activities'],
  pipeline_board: ['get', '/v1/crm/pipeline/board'],
  leads_list: ['get', '/v1/crm/leads'],
  tasks_list: ['get', '/v1/crm/tasks'],
  calendar: ['get', '/v1/crm/calendar/events'],
  notifications: ['get', '/v1/notifications'],
  unread_count: ['get', '/v1/notifications/unread-count'],
  network_search: ['post', '/v1/network/search'],
  network_cursor: ['post', '/v1/network/search'],
  saved_searches: ['get', '/v1/saved-searches'],
};

/** The request's query validated by the route's own contract (what the API would answer 400 to fails here). */
function parseQuery(r: Req): void {
  const url = new URL(r.path, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  const limit = q.limit === undefined ? undefined : Number(q.limit);
  if (limit !== undefined) expect(limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  switch (r.endpoint) {
    case 'listings_list':
    case 'listings_cursor':
      return void ListListingsQuery.parse(q);
    case 'contacts_list':
    case 'contacts_cursor':
      return void ListContactsQuery.parse(q);
    case 'contact_timeline':
    case 'activities':
      return void ListActivitiesQuery.parse(q);
    case 'pipeline_board':
      return void PipelineBoardQuery.parse(q);
    case 'leads_list':
      return void ListLeadsQuery.parse(q);
    case 'tasks_list':
      return void ListTasksQuery.parse(q);
    case 'calendar':
      return void ListCalendarEventsQuery.parse(q);
    case 'notifications':
      return void ListNotificationsQuery.parse(q);
    case 'network_search':
    case 'network_cursor':
      return void NetworkSearchBody.parse(r.body);
    default:
      expect(url.search).toBe('');
  }
}

describe('dashboard API load test (S16-01)', () => {
  it('[S16-01] acceptance profile: 5,000 concurrent users, 15 min steady after a ramp, p95 < 300 ms', () => {
    expect(SLO).toMatchObject({ users: 5_000, seconds: 900, p95Ms: 300, errorRate: 0.001 });
    expect(ACCEPTANCE_PROFILE).toBe('staging');
    const p = resolveProfile({ PROFILE: 'staging' });
    expect(p).toMatchObject({ vus: 5_000, seconds: 900, rampSeconds: 300, p95Ms: 300 });
    // Closed model: one ramping-vus scenario — ramp to 5,000, hold them for the steady phase.
    expect(scenarios(p)).toEqual({
      dashboard: expect.objectContaining({
        executor: 'ramping-vus',
        exec: 'dashboard',
        startVUs: 0,
        stages: [
          { target: 5_000, duration: '300s' },
          { target: 5_000, duration: '900s' },
        ],
      }),
    });
    expect(phaseAt(p, 299_999)).toBe('warmup');
    expect(phaseAt(p, 300_000)).toBe('steady');
    // Its numbers are the acceptance check: no overrides.
    for (const k of ['VUS', 'DURATION', 'RAMP', 'P95_MS']) {
      expect(() => resolveProfile({ PROFILE: 'staging', [k]: '10' })).toThrow(/acceptance check: no/);
    }
    expect(() => resolveProfile({ PROFILE: 'production' })).toThrow(/PROFILE/);
    const empty = { metrics: {} };
    expect(summaryText(empty, p)).toContain('(the acceptance profile)');
  });

  it('[S16-01] thresholds: p95 < 300 ms overall and per endpoint, failed < 0.1 %, checks > 99.9 %, users kept busy', () => {
    const p = PROFILES.staging;
    const t = thresholds(p);
    expect(t['http_req_duration{phase:steady}']).toEqual(['p(95)<300']);
    expect(t['http_req_failed{phase:steady}']).toEqual(['rate<0.001']);
    expect(t['checks{phase:steady}']).toEqual(['rate>0.999']);
    for (const e of ENDPOINTS) expect(t[`http_req_duration{phase:steady,endpoint:${e}}`]).toEqual(['p(95)<300']);
    // 5,000 users × 900 s, one action per (≈ 6.7 s think + 0.3 s), at 80 %: a slow API sends too few and fails.
    const min = minSteadyRequests(p);
    expect(min).toBe(Math.floor((5_000 * 900 * 0.8) / (THINK_MEAN_SECONDS + 0.3)));
    expect(min).toBeGreaterThan(500_000);
    expect(t['http_reqs{phase:steady}']).toEqual([`count>=${min}`]);
    // Token refreshes are tagged `phase: auth`: no threshold judges them.
    expect(Object.keys(t).some((k) => k.includes('token_refresh'))).toBe(false);
  });

  it('[S16-01] smoke and soak profiles: 20 users for 60 s locally; 2,500 users for 24 h (fixed); a labelled soak slice', () => {
    expect(resolveProfile({})).toMatchObject({ name: 'smoke', vus: 20, seconds: 60, p95Ms: 300 });
    expect(resolveProfile({ PROFILE: 'smoke', VUS: '5', DURATION: '30', RAMP: '0' })).toMatchObject({
      vus: 5,
      seconds: 30,
      rampSeconds: 0,
    });
    expect(scenarios(resolveProfile({ PROFILE: 'smoke', RAMP: '0' })).dashboard).toMatchObject({
      startVUs: 20,
      stages: [{ target: 20, duration: '60s' }],
    });
    const soak = resolveProfile({ PROFILE: 'soak' });
    expect(soak).toMatchObject({ vus: 2_500, seconds: 86_400, p95Ms: 300 });
    // The soak's numbers are an acceptance check: no override at all.
    for (const k of ['VUS', 'DURATION', 'RAMP', 'P95_MS']) {
      expect(() => resolveProfile({ PROFILE: 'soak', [k]: '100' })).toThrow(/PROFILE=soak is an acceptance check: no/);
    }
    expect(summaryText({ metrics: {} }, soak)).toContain('(the 24-hour soak profile)');
    // A local slice (20 users, 10 min) takes VUS / DURATION / RAMP (never the budget) and is labelled NOT the
    // acceptance profile — even when given the soak's own numbers.
    const slice = resolveProfile({ PROFILE: 'soak-slice', VUS: '50', DURATION: '3600', RAMP: '30' });
    expect(slice).toMatchObject({ name: 'soak-slice', vus: 50, seconds: 3_600, rampSeconds: 30, p95Ms: 300 });
    expect(() => resolveProfile({ PROFILE: 'soak-slice', P95_MS: '900' })).toThrow(/takes no P95_MS/);
    expect(summaryText({ metrics: {} }, slice)).toContain('a soak slice, NOT the acceptance profile');
    expect(resolveProfile({ PROFILE: 'soak-slice' })).toMatchObject({ vus: 20, seconds: 600, rampSeconds: 10 });
    const asSoak = resolveProfile({ PROFILE: 'soak-slice', VUS: '2500', DURATION: '86400', RAMP: '300' });
    expect(summaryText({ metrics: {} }, asSoak)).toContain('a soak slice, NOT the acceptance profile');
    expect(summaryText({ metrics: {} }, resolveProfile({}))).toContain('NOT the acceptance profile');
  });

  it('[S16-01] mix: the weights sum to 1 and a draw lands on each action at its share', () => {
    const total = Object.values(MIX).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    const rng = rngOf(3);
    const n = 40_000;
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const a = actionAt(rng());
      counts[a] = (counts[a] ?? 0) + 1;
    }
    for (const e of ENDPOINTS) expect(Math.abs((counts[e] ?? 0) / n - MIX[e])).toBeLessThan(0.01);
    expect(actionAt(0)).toBe(ENDPOINTS[0]);
    expect(actionAt(0.999_999_999)).toBe(ENDPOINTS.at(-1));
  });

  it('[S16-01] every endpoint of the mix is a real dashboard route, called with a query its contract accepts', () => {
    for (const [endpoint, [method, pattern]] of Object.entries(ROUTES)) {
      expect(routeSource, `${endpoint}: app.${method}('${pattern}')`).toMatch(
        new RegExp(`app\\.${method}\\(\\s*'${pattern.replace(/[/.]/g, '\\$&')}'`),
      );
    }
    expect(NETWORK_PAGE_MAX).toBe(NETWORK_SEARCH_LIMIT_MAX);
    // Every action, with and without something to follow, many times over.
    const rng = rngOf(11);
    const seen = new Set<Endpoint>();
    for (let i = 0; i < 3_000; i++) {
      const s = newVuState();
      if (i % 2 === 0) {
        s.listingIds.push(LISTING);
        s.contactIds.push(CONTACT);
        s.paging.listings = { query: 'mine=true&sort=newest&limit=25', cursor: 'eyJ4IjoxfQ', depth: 1, maxDepth: 3 };
        s.paging.contacts = { query: 'owner=me&limit=25', cursor: 'eyJ4IjoxfQ', depth: 1, maxDepth: 3 };
        s.paging.network = {
          query: '',
          body: { sort: 'newest', limit: 24 },
          cursor: 'eyJ4IjoxfQ',
          depth: 1,
          maxDepth: 3,
        };
      }
      const r = requestFor(ENDPOINTS[i % ENDPOINTS.length] as Endpoint, rng, s, NOW);
      seen.add(r.endpoint);
      const [method] = ROUTES[r.endpoint];
      expect(r.method.toLowerCase()).toBe(method);
      parseQuery(r);
    }
    expect([...seen].sort()).toEqual([...ENDPOINTS].sort());
  });

  it('[S16-01] cursor following: a first page starts paging, next pages carry its filters and cursor, the end stops it', () => {
    const rng = rngOf(5);
    const s = newVuState();
    // Nothing seen yet: detail and next-page actions open the list first.
    expect(requestFor('listing_detail', rng, s, NOW).endpoint).toBe('listings_list');
    expect(requestFor('contacts_cursor', rng, s, NOW).endpoint).toBe('contacts_list');
    expect(requestFor('network_cursor', rng, s, NOW).endpoint).toBe('network_search');
    const first = requestFor('listings_list', rng, s, NOW);
    observe(s, first, { ids: [LISTING], nextCursor: 'c1' }, rng);
    expect(s.listingIds).toEqual([LISTING]);
    expect(s.paging.listings).toMatchObject({ cursor: 'c1', depth: 1 });
    const maxDepth = s.paging.listings?.maxDepth ?? 0;
    expect(maxDepth).toBeGreaterThanOrEqual(2);
    expect(maxDepth).toBeLessThanOrEqual(5);
    const next = requestFor('listings_cursor', rng, s, NOW);
    expect(next.endpoint).toBe('listings_cursor');
    expect(next.path).toBe(`/v1/listings?${first.first?.query}&cursor=c1`);
    observe(s, next, { ids: [], nextCursor: 'c2' }, rng);
    expect(s.paging.listings).toMatchObject({ cursor: 'c2', depth: 2 });
    observe(s, next, { ids: [], nextCursor: null }, rng);
    expect(s.paging.listings).toBeUndefined();
    expect(requestFor('listing_detail', rng, s, NOW).path).toBe(`/v1/listings/${LISTING}`);
    // Network search pages with the first page's body plus the cursor (a POST).
    const net = requestFor('network_search', rng, s, NOW);
    observe(s, net, { ids: [], nextCursor: 'n1' }, rng);
    const netNext = requestFor('network_cursor', rng, s, NOW);
    expect(netNext).toMatchObject({ method: 'POST', endpoint: 'network_cursor', body: { ...net.body, cursor: 'n1' } });
    // Deep enough: back to a first page.
    if (s.paging.network) s.paging.network.depth = s.paging.network.maxDepth;
    expect(requestFor('network_cursor', rng, s, NOW).endpoint).toBe('network_search');
    // A VU keeps the 50 most recent ids it saw.
    const many = Array.from({ length: 80 }, (_, i) => `0195f0a5-0001-7000-8000-${String(i).padStart(12, '0')}`);
    observe(s, first, { ids: many, nextCursor: null }, rng);
    expect(s.listingIds).toHaveLength(50);
    expect(s.listingIds.at(-1)).toBe(many.at(-1));
  });

  it('[S16-01] think time: 2–16 s, mean ≈ 6.7 s — a working member, not a request loop', () => {
    const rng = rngOf(9);
    const xs = Array.from({ length: 20_000 }, () => thinkSeconds(rng));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...xs)).toBeLessThanOrEqual(16);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean - THINK_MEAN_SECONDS)).toBeLessThan(0.15);
    // At 5,000 users that is ≈ 700 rps on the API — mostly short list reads.
    expect(5_000 / THINK_MEAN_SECONDS).toBeGreaterThan(700);
  });

  it('[S16-01] tokens: refreshed 2–3 min before expiry; a run longer than the tokens without a refresh service is refused', () => {
    const exp = NOW + 15 * 60_000;
    expect(refreshDue(exp, NOW, 0)).toBe(false);
    expect(refreshDue(exp, exp - 121_000, 0)).toBe(false);
    expect(refreshDue(exp, exp - 119_000, 0)).toBe(true);
    expect(refreshDue(exp, exp - 179_000, 0.999)).toBe(true);
    // The 70-second smoke fits in one token lifetime; the acceptance run (20 min) and the soak do not.
    expect(tokensLastProblem(PROFILES.smoke, exp, NOW, false)).toBeNull();
    expect(tokensLastProblem(PROFILES.staging, exp, NOW, false)).toMatch(/refresh service/);
    expect(tokensLastProblem(PROFILES.soak, exp, NOW, true)).toBeNull();
  });

  it('[S16-01] office addresses: one per agency, private range, distinct', () => {
    expect(officeAddress(0)).toBe('10.0.0.1');
    expect(officeAddress(256)).toBe('10.0.1.1');
    const all = new Set(Array.from({ length: 5_000 }, (_, i) => officeAddress(i)));
    expect(all.size).toBe(5_000);
    for (const a of all) expect(a).toMatch(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it('[S16-01] summary: p50 / p95 / p99 and requests per endpoint, failed thresholds named', () => {
    const p = PROFILES.smoke;
    const run: SummaryData = {
      metrics: {
        'http_req_duration{phase:steady}': {
          values: { med: 12.34, 'p(95)': 80, 'p(99)': 140 },
          thresholds: { 'p(95)<300': { ok: true } },
        },
        'http_reqs{phase:steady}': { values: { count: 600 } },
        'http_req_failed{phase:steady}': { values: { rate: 0.002 }, thresholds: { 'rate<0.001': { ok: false } } },
        'http_req_duration{phase:steady,endpoint:pipeline_board}': { values: { med: 20, 'p(95)': 310, 'p(99)': 400 } },
        'http_reqs{phase:steady,endpoint:pipeline_board}': { values: { count: 40 } },
        token_refreshes: { values: { count: 3 } },
      },
    };
    const r = summaryReport(run, p);
    expect(r).toMatchObject({ requests: 600, rps: 10, errorRate: 0.002, tokenRefreshes: 3, pass: false });
    expect(r.rows[0]).toEqual({ name: 'all (steady)', p50: 12.3, p95: 80, p99: 140, count: 600 });
    expect(r.rows.find((x) => x.name === 'pipeline_board')).toMatchObject({ p95: 310, count: 40 });
    expect(r.failedThresholds).toEqual(['http_req_failed{phase:steady} rate<0.001']);
    expect(summaryText(run, p)).toContain('FAIL: http_req_failed{phase:steady} rate<0.001');
  });

  it('[S16-01] a VU over many actions stays inside the contracts and the page-size cap', () => {
    const rng = rngOf(21);
    const s = newVuState();
    for (let i = 0; i < 5_000; i++) {
      const r = nextRequest(rng, s, NOW);
      parseQuery(r);
      if (r.list) observe(s, r, { ids: r.list === 'contacts' ? [CONTACT] : [LISTING], nextCursor: 'eyJ4IjoxfQ' }, rng);
    }
  });
});

describe('load-test token refresh service (S16-01)', () => {
  let service: TokenService | undefined;
  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  const members: LoadMember[] = [
    { agencyId: LISTING, userId: CONTACT, sessionVersion: 1, agencyOrdinal: 1 },
    { agencyId: LISTING, userId: LISTING, sessionVersion: 1, agencyOrdinal: 1 },
  ];

  it('[S16-01] serves a member its tokens behind the per-run secret, minting again only when due', async () => {
    let n = 0;
    const mint = async (m: LoadMember) => {
      n++;
      return { api: `api-${m.userId}-${n}`, realtime: `rt-${n}`, expiresAt: new Date(Date.now() + 15 * 60_000) };
    };
    const soon = new Date(Date.now() + 60_000).toISOString();
    service = await startTokenService({
      members,
      mint,
      initial: {
        users: [{ agencyId: LISTING, userId: CONTACT, api: 'old', realtime: 'old-rt', index: 0, office: '10.0.0.2' }],
        issuedAt: new Date().toISOString(),
        expiresAt: soon,
        refresh: null,
      },
    });
    expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const get = (path: string, auth?: string) =>
      fetch(`${service?.url}${path}`, auth ? { headers: { authorization: auth } } : {});
    // No secret, a wrong one, a member outside the file, another path: refused.
    expect((await get('/tokens/0')).status).toBe(401);
    expect((await get('/tokens/0', 'Bearer nope')).status).toBe(401);
    expect((await get('/tokens/2', `Bearer ${service.secret}`)).status).toBe(404);
    expect((await get('/admin', `Bearer ${service.secret}`)).status).toBe(404);
    // Member 0's file token expires within 5 minutes: minted again; then served from memory.
    const a = await get('/tokens/0', `Bearer ${service.secret}`);
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toBe('no-store');
    const body = (await a.json()) as { api: string; realtime: string; expiresAt: string };
    expect(body).toMatchObject({ api: `api-${CONTACT}-1`, realtime: 'rt-1' });
    const again = (await (await get('/tokens/0', `Bearer ${service.secret}`)).json()) as { api: string };
    expect(again.api).toBe(body.api);
    // Two concurrent asks for a due member: one mint.
    await Promise.all([get('/tokens/1', `Bearer ${service.secret}`), get('/tokens/1', `Bearer ${service.secret}`)]);
    expect(service.remints()).toBe(2);
    expect(n).toBe(2);
  });

  it('[S16-01] binds off loopback only behind TLS: a non-loopback --host needs an https: --public-url', async () => {
    for (const h of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '10.0.0.5', '::', 'loadgen.internal']) expect(isLoopbackHost(h)).toBe(false);
    expect(() => assertRefreshExposure('127.0.0.1', undefined)).not.toThrow();
    expect(() => assertRefreshExposure('0.0.0.0', undefined)).toThrow(/TLS proxy/);
    expect(() => assertRefreshExposure('0.0.0.0', 'http://loadgen:4790')).toThrow(/https: --public-url/);
    expect(() => assertRefreshExposure('0.0.0.0', 'not a url')).toThrow(/TLS proxy/);
    expect(() => assertRefreshExposure('0.0.0.0', 'https://tokens.loadgen.example')).not.toThrow();
    expect(() => assertRefreshExposure('0.0.0.0', undefined, true)).not.toThrow(); // the local smoke's docker gateway
    await expect(startTokenService({ members, host: '0.0.0.0', mint: async () => never() })).rejects.toThrow(
      /not loopback/,
    );
  });

  it('[S16-01] refresh mints are throttled: at most MINT_CONCURRENCY (here 2) in flight, every ask answered', async () => {
    let active = 0;
    let peak = 0;
    const mint = async (m: LoadMember) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { api: `api-${m.userId}`, realtime: 'rt', expiresAt: new Date(Date.now() + 15 * 60_000) };
    };
    const many: LoadMember[] = Array.from({ length: 6 }, (_, i) => ({
      agencyId: LISTING,
      userId: `u${i}`,
      sessionVersion: 1,
      agencyOrdinal: 1,
    }));
    service = await startTokenService({ members: many, mint, concurrency: 2 });
    const s = service;
    const res = await Promise.all(
      many.map((_, i) => fetch(`${s.url}/tokens/${i}`, { headers: { authorization: `Bearer ${s.secret}` } })),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(peak).toBe(2);
    expect(s.remints()).toBe(6);
    // the limiter itself: FIFO, a failed run frees its slot
    const run = createLimiter(1);
    await expect(run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await run(async () => 'next')).toBe('next');
  });
});

function never(): never {
  throw new Error('not called');
}
