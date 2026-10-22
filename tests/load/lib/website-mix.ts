/**
 * Website API load test (S7-08, PLAN §15 "Website API mix"): the scenario mix, the load profiles, the thresholds that
 * encode the acceptance check and the visitor-like query distributions. Pure — no k6 module, no Node module — so
 * k6 (`tests/load/website-api.js`, TypeScript support built in) and Vitest (`website-mix.test.ts`) run the same code.
 */

/** Share of the request rate per scenario (PLAN §15): search 60 %, detail 30 %, taxonomy / changes 10 %. */
export const MIX = { search: 0.6, detail: 0.3, other: 0.1 } as const;
export type ScenarioName = keyof typeof MIX;

/** The acceptance check (S7-08): 1,000 rps at origin sustained 15 min, p95 < 150 ms, error rate < 0.1 %. */
export const SLO = { rps: 1_000, seconds: 15 * 60, p95Ms: 150, errorRate: 0.001 } as const;

export interface Profile {
  /** Requests per second over the whole mix (steady phase). */
  rate: number;
  /** Steady phase length, seconds (what the thresholds judge). */
  seconds: number;
  /** Ramp from 0 to `rate` before the steady phase (warms pools and caches; not judged). */
  warmupSeconds: number;
  /** Through the CDN with the `_k` edge token (S7-06), instead of origin only. */
  edge: boolean;
  /**
   * Search engine stopped (S7-F9): every website search must be answered by the Postgres fallback (`degraded: true`
   * in `/v2/listings`) — a threshold, so a run where the engine still answered cannot pass as a degraded-engine run.
   */
  degraded: boolean;
  p95Ms: number;
  errorRate: number;
  preAllocatedVUs: number;
  maxVUs: number;
}

/**
 * - `smoke`: `pnpm perf:smoke` — a 60-second local run at a low rate against the local scale seed.
 * - `staging`: the acceptance run (H4) — 1,000 rps at origin for 15 minutes.
 * - `spike`: PLAN §15's 2,000 rps through the edge (CDN in front, `_k` on every request); not the acceptance check.
 * - `degraded`: S7-F9 — the acceptance run's rate, length and thresholds with Meilisearch stopped (circuit open): website
 *   search from the Postgres fallback (PLAN §15 chaos drill "kill search → Postgres fallback serves").
 */
export const PROFILES = {
  smoke: {
    rate: 20,
    seconds: 60,
    warmupSeconds: 10,
    edge: false,
    degraded: false,
    p95Ms: SLO.p95Ms,
    errorRate: SLO.errorRate,
    preAllocatedVUs: 10,
    maxVUs: 50,
  },
  staging: {
    rate: SLO.rps,
    seconds: SLO.seconds,
    warmupSeconds: 120,
    edge: false,
    degraded: false,
    p95Ms: SLO.p95Ms,
    errorRate: SLO.errorRate,
    preAllocatedVUs: 400,
    maxVUs: 2_000,
  },
  degraded: {
    rate: SLO.rps,
    seconds: SLO.seconds,
    warmupSeconds: 120,
    edge: false,
    degraded: true,
    p95Ms: SLO.p95Ms,
    errorRate: SLO.errorRate,
    preAllocatedVUs: 400,
    maxVUs: 2_000,
  },
  spike: {
    rate: 2 * SLO.rps,
    seconds: 5 * 60,
    warmupSeconds: 60,
    edge: true,
    degraded: false,
    p95Ms: SLO.p95Ms,
    errorRate: SLO.errorRate,
    preAllocatedVUs: 400,
    maxVUs: 3_000,
  },
} as const satisfies Record<string, Profile>;
export type ProfileName = keyof typeof PROFILES;

const positive = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

/** The profile that is the acceptance check (S7-08): it takes no overrides. */
export const ACCEPTANCE_PROFILE: ProfileName = 'staging';
/** Profiles whose numbers are an acceptance check (S7-08; S7-F9's degraded-engine run): no overrides. */
const FIXED_PROFILES: ReadonlySet<ProfileName> = new Set([ACCEPTANCE_PROFILE, 'degraded']);
const OVERRIDES = ['RATE', 'DURATION', 'WARMUP', 'EDGE', 'P95_MS', 'DEGRADED'] as const;

/**
 * The profile named by `PROFILE` (default smoke), with `RATE`, `DURATION` (s), `WARMUP` (s), `EDGE`, `P95_MS` and
 * `DEGRADED` (1: expect the engine stopped, e.g. `pnpm perf:smoke` on the fallback) overrides — except the acceptance
 * profiles, which refuse them (their numbers are the acceptance check).
 */
export function resolveProfile(env: Record<string, string | undefined>): Profile & { name: ProfileName } {
  const name = (env.PROFILE ?? 'smoke') as ProfileName;
  const base: Profile | undefined = PROFILES[name];
  if (!base) throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}`);
  const overridden = OVERRIDES.filter((k) => env[k] !== undefined && env[k] !== '');
  if (FIXED_PROFILES.has(name) && overridden.length > 0) {
    throw new Error(`PROFILE=${name} is the acceptance check: no ${overridden.join(', ')} override`);
  }
  const rate = positive('RATE', env.RATE) ?? base.rate;
  return {
    ...base,
    name,
    rate,
    seconds: positive('DURATION', env.DURATION) ?? base.seconds,
    warmupSeconds: env.WARMUP === '0' ? 0 : (positive('WARMUP', env.WARMUP) ?? base.warmupSeconds),
    edge: env.EDGE === undefined || env.EDGE === '' ? base.edge : env.EDGE === '1',
    degraded: env.DEGRADED === undefined || env.DEGRADED === '' ? base.degraded : env.DEGRADED === '1',
    p95Ms: positive('P95_MS', env.P95_MS) ?? base.p95Ms,
    // Little's law with headroom: rate × 0.2 s in flight, at least the profile's own.
    preAllocatedVUs: Math.max(base.preAllocatedVUs, Math.ceil(rate * 0.2)),
    maxVUs: Math.max(base.maxVUs, Math.ceil(rate * 2)),
  };
}

const STEADY = { phase: 'steady' } as const;

/**
 * k6 `scenarios`: a warm-up ramp (the whole mix, `phase: warmup`) and then one constant-arrival-rate scenario per
 * mix share (`phase: steady`), so each share keeps its rate whatever the latency (open model: a slow origin shows as
 * latency and dropped iterations, never as a lower rate).
 */
export function scenarios(p: Profile): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const start = `${p.warmupSeconds}s`;
  if (p.warmupSeconds > 0) {
    out.warmup = {
      executor: 'ramping-arrival-rate',
      exec: 'mixed',
      startRate: 0,
      timeUnit: '1s',
      stages: [{ target: p.rate, duration: `${p.warmupSeconds}s` }],
      preAllocatedVUs: p.preAllocatedVUs,
      maxVUs: p.maxVUs,
      tags: { phase: 'warmup' },
    };
  }
  for (const [name, share] of Object.entries(MIX) as [ScenarioName, number][]) {
    const rate = Math.max(1, Math.round(p.rate * share));
    out[name] = {
      executor: 'constant-arrival-rate',
      exec: name,
      rate,
      timeUnit: '1s',
      duration: `${p.seconds}s`,
      startTime: start,
      preAllocatedVUs: Math.max(1, Math.ceil(p.preAllocatedVUs * share)),
      maxVUs: Math.max(2, Math.ceil(p.maxVUs * share)),
      tags: STEADY,
    };
  }
  return out;
}

/** Share of steady-phase searches answered `degraded: true` (the Postgres fallback), recorded in every run (S7-F9). */
export const DEGRADED_METRIC = 'search_degraded';

/** Endpoint tags of the mix (per-endpoint p95 in the summary). */
export const ENDPOINTS = [
  'search_first',
  'search_cursor',
  'search_map',
  'detail',
  'taxonomy',
  'changes_since',
  'changes_cursor',
] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/**
 * k6 `thresholds` — the acceptance check as code, judged on the steady phase only: p95 under budget overall, per
 * scenario and per endpoint; failed requests (anything but 200 / 304) under the error rate; ≥ 99.9 % of response
 * checks pass; and the rate was held — at least 99 % of the planned requests were sent and no more than 1 % dropped.
 */
export function thresholds(p: Profile): Record<string, string[]> {
  const steady = '{phase:steady}';
  const planned = Object.values(MIX).reduce((n, share) => n + Math.max(1, Math.round(p.rate * share)), 0) * p.seconds;
  const t: Record<string, string[]> = {
    [`http_req_duration${steady}`]: [`p(95)<${p.p95Ms}`],
    [`http_req_failed${steady}`]: [`rate<${p.errorRate}`],
    [`checks${steady}`]: ['rate>0.999'],
    [`http_reqs${steady}`]: [`count>=${Math.floor(planned * 0.99)}`],
    [`dropped_iterations${steady}`]: [`count<=${Math.ceil(planned * 0.01)}`],
  };
  for (const s of Object.keys(MIX)) t[`http_req_duration{scenario:${s}}`] = [`p(95)<${p.p95Ms}`];
  for (const e of ENDPOINTS) t[`http_req_duration{phase:steady,endpoint:${e}}`] = [`p(95)<${p.p95Ms}`];
  // S7-F9: a degraded-engine run proves the fallback answered (a search answered by the engine fails it).
  if (p.degraded) t[`${DEGRADED_METRIC}${steady}`] = ['rate>0.999'];
  return t;
}

/** The website limits a load-test key runs under (identity `API_KEYS`, website-api `DEFAULT_WEBSITE_LIMITS`, HIGH tier). */
export interface KeyLimits {
  /** Per key per minute (the key's tier). */
  perKeyPerMinute: number;
  /** All keys of one agency per minute (each load-test key is another agency's). */
  agencyPerMinute: number;
  /** Per key per burst window. */
  burst: number;
  burstWindowSeconds: number;
  /** Per key per UTC day. */
  dailyQuota: number;
  /**
   * Per client IP per minute on the keyed website routes (S7-F9): the load generator sends everything from one IP, so
   * the whole rate counts against it and more keys do not help. Null: none — feed-api's keyed routes are limited by key,
   * agency and browser only (`KEYED_ROUTE_LIMITS`); the per-IP rule left counts failed key checks only.
   */
  ipPerMinute: number | null;
}

/** Headroom under every limit: a key never runs above 80 % of one (random picks still cluster a little). */
export const KEY_HEADROOM = 0.8;

/** The rate one client IP can send within 80 % of the per-IP limit (S7-F9); throws when the whole rate cannot. */
export function assertIpHeadroom(rate: number, l: KeyLimits): void {
  if (l.ipPerMinute !== null && rate > (KEY_HEADROOM * l.ipPerMinute) / 60) {
    throw new Error(
      `${rate} rps from one load-generator IP is over 80 % of the per-IP limit (${l.ipPerMinute} / min): more keys do not help`,
    );
  }
}

/** The largest share of the rate one key may carry without passing 80 % of a limit (the per-IP limit checked first). */
export function maxKeyShare(rate: number, seconds: number, l: KeyLimits): number {
  assertIpHeadroom(rate, l);
  const perSecond = Math.min(Math.min(l.perKeyPerMinute, l.agencyPerMinute) / 60, l.burst / l.burstWindowSeconds);
  return Math.min(1, (KEY_HEADROOM * perSecond) / rate, (KEY_HEADROOM * l.dailyQuota) / (rate * seconds));
}

/**
 * Site weights (S7-08 review: a realistic working set): Zipf over the sites (exponent `s`: a few busy sites and a
 * long tail), every weight capped at `maxShare` and the excess spread over the others (water-filling), so the
 * busiest key stays under its limits. Sums to 1; with `n × maxShare < 1` no weighting can, and more sites are needed.
 */
export function siteWeights(n: number, maxShare: number, s = 1): number[] {
  if (n < 1) return [];
  if (n * maxShare < 1) throw new Error(`${n} sites cannot carry the rate at ≤ ${maxShare} each: more sites needed`);
  const raw = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
  const capped = new Set<number>();
  for (;;) {
    const free = raw.reduce((t, w, i) => (capped.has(i) ? t : t + w), 0);
    const left = 1 - capped.size * maxShare;
    const over = raw.findIndex((w, i) => !capped.has(i) && (w / free) * left > maxShare);
    if (over < 0) return raw.map((w, i) => (capped.has(i) ? maxShare : (w / free) * left));
    for (let i = 0; i < n; i++) if (!capped.has(i) && ((raw[i] as number) / free) * left > maxShare) capped.add(i);
  }
}

/** Cumulative weights, for `pickWeighted`. */
export function cumulative(weights: readonly number[]): number[] {
  let t = 0;
  return weights.map((w) => {
    t += w;
    return t;
  });
}

/** Index of a draw over cumulative weights (binary search). */
export function pickWeighted(rng: Rng, cum: readonly number[]): number {
  const x = rng() * (cum[cum.length - 1] ?? 1);
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Keys needed so that `rate` rps for `seconds`, spread evenly over the keys (one site and agency each), stays under
 * 80 % of every enforced limit: tier rate, agency ceiling, burst and daily quota. No bypass is needed — the load test
 * runs through the real limiter, as production traffic does.
 */
export function keysNeeded(rate: number, seconds: number, l: KeyLimits): number {
  assertIpHeadroom(rate, l);
  const perMinute = Math.min(l.perKeyPerMinute, l.agencyPerMinute) / 60;
  const perSecondBurst = l.burst / l.burstWindowSeconds;
  const byRate = rate / (KEY_HEADROOM * Math.min(perMinute, perSecondBurst));
  const byQuota = (rate * seconds) / (KEY_HEADROOM * l.dailyQuota);
  return Math.max(1, Math.ceil(Math.max(byRate, byQuota)));
}

/** What `setup()` learns from the sites (first pages, sitemap, taxonomy, changes) to build visitor-like queries. */
export interface SitePool {
  /** The site's references (sitemap), for detail requests. */
  refs: string[];
  /** Region and city ids seen on the site's cards. */
  locations: string[];
  /** Property type ids (taxonomy and cards). */
  types: string[];
  /** The site's locales (default first). */
  langs: string[];
  /**
   * Page 2 of several searches: the first page's query string with its `nextCursor` (a cursor continues the search
   * it came from — the same filters and sort, as a website pages).
   */
  pages: string[];
  /** `nextCursor`s of `/v2/changes` (a plugin polling). */
  changeCursors: string[];
  /** Card coordinates (map view boxes around them). */
  points: [number, number][];
}

export type Rng = () => number;

export const pick = <T>(rng: Rng, xs: readonly T[]): T | undefined =>
  xs.length === 0 ? undefined : xs[Math.floor(rng() * xs.length) % xs.length];

/** Shares of first-page searches: price band, beds, location, type, sort and a map view. */
export const SEARCH_SHARES = {
  /** Paging on (page 2+ from a harvested cursor) instead of a first page. */
  cursor: 0.25,
  /** A map view (`bbox`) among first pages. */
  map: 0.1,
  location: 0.55,
  type: 0.3,
  price: 0.4,
  beds: 0.4,
  rent: 0.15,
  facets: 0.2,
  /** `lang` sent (else the site's default). */
  lang: 0.6,
} as const;

const SORTS = ['newest', 'newest', 'newest', 'price_asc', 'price_asc', 'price_desc', 'beds_desc', 'area_desc'];
const PAGE_SIZES = [12, 12, 24, 24, 24, 24, 48];
/** Price bands of a Spanish coast buyer (cents): from-to pairs, either end open. */
const PRICE_BANDS: [number | null, number | null][] = [
  [null, 20_000_000],
  [10_000_000, 30_000_000],
  [20_000_000, 50_000_000],
  [30_000_000, 80_000_000],
  [50_000_000, null],
  [100_000_000, null],
];

const qs = (params: [string, string | number][]) =>
  params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

/** A next page's query string: the first page's `query` with its `nextCursor`. */
export const nextPageQuery = (query: string, cursor: string) => `${query}&${qs([['cursor', cursor]])}`;

export interface Req {
  path: string;
  endpoint: Endpoint;
  /** A first page's query (no cursor): the VU follows its `nextCursor` on later iterations. */
  query?: string;
}

/** A visitor paging through one search: its query, the next cursor and how deep it goes. */
export interface Session {
  query: string;
  cursor: string;
  depth: number;
  maxDepth: number;
}

/** A session after a first page with a `nextCursor`: pages 2 to 6 (most visitors stop early). */
export function startSession(rng: Rng, query: string, cursor: string | null | undefined): Session | undefined {
  if (!cursor) return undefined;
  return { query, cursor, depth: 1, maxDepth: 2 + Math.floor(rng() ** 2 * 5) };
}

/**
 * A search the way website visitors run them: mostly first pages with a few filters, some next pages — the VU's own
 * search followed by its `nextCursor` to a random depth (else a harvested page 2), some map views.
 */
export function searchRequest(rng: Rng, pool: SitePool, session?: Session): Req {
  if (rng() < SEARCH_SHARES.cursor) {
    if (session && session.depth < session.maxDepth) {
      return { path: `/v2/listings?${nextPageQuery(session.query, session.cursor)}`, endpoint: 'search_cursor' };
    }
    const page = pick(rng, pool.pages);
    if (page) return { path: `/v2/listings?${page}`, endpoint: 'search_cursor' };
  }
  const params: [string, string | number][] = [];
  const lang = rng() < SEARCH_SHARES.lang ? pick(rng, pool.langs) : undefined;
  if (lang) params.push(['lang', lang]);
  const point = rng() < SEARCH_SHARES.map ? pick(rng, pool.points) : undefined;
  if (point) {
    const [lat, lng] = point;
    const r = 0.1 + rng() * 0.4;
    const f = (n: number) => n.toFixed(4);
    params.push(['bbox', `${f(lat + r)},${f(lng - r)},${f(lat - r)},${f(lng + r)}`], ['limit', 100]);
    return { path: `/v2/listings?${qs(params)}`, endpoint: 'search_map' };
  }
  if (rng() < SEARCH_SHARES.rent) params.push(['transaction', 'RENT_LONG_TERM']);
  const location = rng() < SEARCH_SHARES.location ? pick(rng, pool.locations) : undefined;
  if (location) params.push(['locations', location]);
  const type = rng() < SEARCH_SHARES.type ? pick(rng, pool.types) : undefined;
  if (type) params.push(['types', type]);
  if (rng() < SEARCH_SHARES.price) {
    const [min, max] = pick(rng, PRICE_BANDS) ?? [null, null];
    if (min !== null) params.push(['priceMin', min]);
    if (max !== null) params.push(['priceMax', max]);
  }
  if (rng() < SEARCH_SHARES.beds) params.push(['bedsMin', 1 + Math.floor(rng() * 4)]);
  if (rng() < SEARCH_SHARES.facets) params.push(['facets', 'propertyTypeId,beds']);
  params.push(['sort', pick(rng, SORTS) ?? 'newest'], ['limit', pick(rng, PAGE_SIZES) ?? 24]);
  return { path: `/v2/listings?${qs(params)}`, endpoint: 'search_first', query: qs(params) };
}

/** A listing page: a reference the site shows (sitemap), in one of its languages. */
export function detailRequest(rng: Rng, pool: SitePool): Req | undefined {
  const ref = pick(rng, pool.refs);
  if (!ref) return undefined;
  const lang = rng() < SEARCH_SHARES.lang ? pick(rng, pool.langs) : undefined;
  return {
    path: `/v2/listings/${encodeURIComponent(ref)}${lang ? `?${qs([['lang', lang]])}` : ''}`,
    endpoint: 'detail',
  };
}

const TAXONOMY = ['/v2/taxonomy/types', '/v2/taxonomy/features', '/v2/taxonomy/locations'];

/** The change log's retention (search `PUBLIC_CHANGES_RETENTION_DAYS`; a unit test keeps them equal). */
export const CHANGE_LOG_RETENTION_DAYS = 30;

/**
 * The rest: taxonomy (search forms) half the time, the change feed (plugins polling) the other half — continuing the
 * VU's own change cursor for the site when it has one (`changeCursor`), else a harvested one or a `since` start.
 */
export function otherRequest(rng: Rng, pool: SitePool, nowMs: number, changeCursor?: string): Req {
  if (rng() < 0.5) {
    const path = pick(rng, TAXONOMY) ?? TAXONOMY[0];
    const lang = rng() < SEARCH_SHARES.lang ? pick(rng, pool.langs) : undefined;
    return { path: `${path}${lang ? `?${qs([['lang', lang]])}` : ''}`, endpoint: 'taxonomy' };
  }
  const cursor = rng() < 0.6 ? (changeCursor ?? pick(rng, pool.changeCursors)) : undefined;
  if (cursor) return { path: `/v2/changes?${qs([['cursor', cursor]])}`, endpoint: 'changes_cursor' };
  // A plugin catching up after any gap the log still covers: `since` 5 minutes to the retention ago, log-uniform (most
  // gaps short, some days long).
  const maxMinutes = CHANGE_LOG_RETENTION_DAYS * 24 * 60 - 60;
  const since = new Date(nowMs - 5 * (maxMinutes / 5) ** rng() * 60_000).toISOString();
  return {
    path: `/v2/changes?${qs([
      ['since', since],
      ['limit', 200],
    ])}`,
    endpoint: 'changes_since',
  };
}

/**
 * The S7-06 edge-cache token: base64url(SHA-256(`<key>\n<Origin or empty>`)), first 22 characters — `sha256Url` is
 * the runtime's SHA-256 with unpadded base64url output (k6: `crypto.sha256(s, 'base64rawurl')`).
 */
export function edgeToken(key: string, origin: string, sha256Url: (s: string) => string): string {
  return sha256Url(`${key}\n${origin}`).slice(0, 22);
}

/** `path` with `_k` appended (edge mode). */
export function withEdgeToken(path: string, token: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}_k=${token}`;
}

interface TrendValues {
  med?: number;
  'p(95)'?: number;
  'p(99)'?: number;
  max?: number;
  count?: number;
  rate?: number;
}
interface SummaryMetric {
  values: TrendValues;
  thresholds?: Record<string, { ok: boolean }>;
}
export interface SummaryData {
  metrics: Record<string, SummaryMetric | undefined>;
}

export interface SummaryRow {
  name: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** The numbers the STATUS entry and the runbook record, from k6's end-of-test summary. */
export function summaryReport(data: SummaryData, p: Profile) {
  const m = data.metrics;
  const ms = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  const row = (name: string, metric: string): SummaryRow => {
    const v = m[metric]?.values ?? {};
    return { name, p50: ms(v.med), p95: ms(v['p(95)']), p99: ms(v['p(99)']) };
  };
  const rows: SummaryRow[] = [
    row('all (steady)', 'http_req_duration{phase:steady}'),
    ...Object.keys(MIX).map((s) => row(s, `http_req_duration{scenario:${s}}`)),
    ...ENDPOINTS.map((e) => row(e, `http_req_duration{phase:steady,endpoint:${e}}`)),
  ];
  const requests = m['http_reqs{phase:steady}']?.values.count ?? 0;
  const failed = m['http_req_failed{phase:steady}']?.values.rate ?? 0;
  const failedThresholds = Object.entries(m).flatMap(([name, metric]) =>
    Object.entries(metric?.thresholds ?? {})
      .filter(([, t]) => !t.ok)
      .map(([expr]) => `${name} ${expr}`),
  );
  return {
    target: {
      rps: p.rate,
      seconds: p.seconds,
      edge: p.edge,
      degraded: p.degraded,
      p95Ms: p.p95Ms,
      errorRate: p.errorRate,
    },
    requests,
    rps: Math.round((requests / p.seconds) * 10) / 10,
    errorRate: failed,
    dropped: m['dropped_iterations{phase:steady}']?.values.count ?? 0,
    edgeHitRate: m.edge_hits?.values.rate ?? null,
    degradedRate: m[`${DEGRADED_METRIC}{phase:steady}`]?.values.rate ?? null,
    rows,
    failedThresholds,
    pass: failedThresholds.length === 0,
  };
}

/** The summary as text (k6 `handleSummary` stdout). */
export function summaryText(data: SummaryData, p: Profile): string {
  const r = summaryReport(data, p);
  const n = (v: number | null) => (v === null ? '     -' : v.toFixed(1).padStart(6));
  const same = (a: Profile) =>
    p.rate === a.rate &&
    p.seconds === a.seconds &&
    p.edge === a.edge &&
    p.degraded === a.degraded &&
    p.p95Ms === a.p95Ms &&
    p.errorRate === a.errorRate;
  const label = same(PROFILES[ACCEPTANCE_PROFILE])
    ? ' (the acceptance profile)'
    : same(PROFILES.degraded)
      ? ' (the degraded-engine acceptance profile, S7-F9)'
      : ' — NOT the acceptance profile';
  const lines = [
    `website API load test — ${r.target.edge ? 'edge' : 'origin'}${r.target.degraded ? ', search engine stopped' : ''}, target ${r.target.rps} rps for ${r.target.seconds} s${label}`,
    `  sent ${r.requests} requests in the steady phase = ${r.rps} rps; errors ${(r.errorRate * 100).toFixed(3)} %; dropped ${r.dropped}` +
      (r.edgeHitRate === null ? '' : `; edge hits ${(r.edgeHitRate * 100).toFixed(1)} %`) +
      (r.degradedRate === null ? '' : `; searches from the fallback ${(r.degradedRate * 100).toFixed(1)} %`),
    '  latency ms              p50     p95     p99',
    ...r.rows.map((x) => `  ${x.name.padEnd(20)} ${n(x.p50)}  ${n(x.p95)}  ${n(x.p99)}`),
    r.pass ? '  PASS: every threshold held' : `  FAIL: ${r.failedThresholds.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}
