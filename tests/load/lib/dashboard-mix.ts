/**
 * Dashboard load test (S16-01, PLAN §15 "Dashboard: 5,000 concurrent users; API p95 < 300 ms"): the actions a working
 * agent's dashboard sends to the API, their weights, think time, cursor following, the load profiles and the
 * thresholds that encode the acceptance check. Pure — no k6 module, no Node module — so k6 (`tests/load/dashboard.js`)
 * and Vitest (`dashboard-mix.test.ts`) run the same code.
 *
 * Closed model: "concurrent users" are virtual users that each act, read the answer and think — so a slow API shows as
 * latency and a lower request rate, and the thresholds also require a minimum steady-phase request count.
 */

/** The acceptance check (S16-01): 5,000 concurrent users, 15 minutes steady, p95 < 300 ms, errors < 0.1 %. */
export const SLO = { users: 5_000, seconds: 15 * 60, p95Ms: 300, errorRate: 0.001, checks: 0.999 } as const;

/** Page size of every list the mix sends: CLAUDE.md's dashboard budget allows at most 100 a page. */
export const MAX_PAGE_SIZE = 100;
/** Network search's own maximum (`NETWORK_SEARCH_LIMIT_MAX`, contracts; a unit test keeps them equal). */
export const NETWORK_PAGE_MAX = 50;

/**
 * The actions and their share of a working agent's requests (weights sum to 1). The dashboard's hot GET routes
 * (`apps/api/src/routes/*`): the own listings list (filters, then its next pages) and a listing; contacts (list, next
 * page, one contact, its activity timeline); the CRM activity feed, pipeline board, leads and tasks; the calendar;
 * notifications (the bell's unread count is polled most); network search (`POST`, a read) and its next page; saved
 * searches (matching). Detail and next-page actions fall back to the list when the VU has nothing to follow yet.
 */
export const MIX = {
  listings_list: 0.16,
  listings_cursor: 0.06,
  listing_detail: 0.12,
  contacts_list: 0.1,
  contacts_cursor: 0.03,
  contact_detail: 0.05,
  contact_timeline: 0.05,
  activities: 0.03,
  pipeline_board: 0.07,
  leads_list: 0.05,
  tasks_list: 0.05,
  calendar: 0.03,
  notifications: 0.04,
  unread_count: 0.06,
  network_search: 0.07,
  network_cursor: 0.02,
  saved_searches: 0.01,
} as const;
export type Endpoint = keyof typeof MIX;
export const ENDPOINTS = Object.keys(MIX) as Endpoint[];

/** Lists whose `nextCursor` a VU follows (keyset pagination, never OFFSET). */
export type ListKind = 'listings' | 'contacts' | 'network';

export interface Profile {
  /** Concurrent virtual users in the steady phase (each one a scale-seed member with its own token). */
  vus: number;
  /** Ramp from 0 to `vus` before the steady phase (not judged). */
  rampSeconds: number;
  /** Steady phase length, seconds (what the thresholds judge). */
  seconds: number;
  p95Ms: number;
  errorRate: number;
}

/**
 * - `smoke`: `pnpm perf:smoke dashboard` — 20 users for 60 s against the local scale seed.
 * - `staging`: the acceptance run (H4) — 5,000 concurrent users, 15 minutes steady after a 5-minute ramp.
 * - `soak`: PLAN §15 soak — 50 % of the users (2,500) for 24 h at the same budgets. An acceptance check: no override.
 * - `soak-slice`: a local slice of the soak — 20 users for 10 minutes, `VUS`, `DURATION` and `RAMP` overrides — NOT
 *   the acceptance soak, and its summary says so.
 */
export const PROFILES = {
  smoke: { vus: 20, rampSeconds: 10, seconds: 60, p95Ms: SLO.p95Ms, errorRate: SLO.errorRate },
  staging: { vus: SLO.users, rampSeconds: 300, seconds: SLO.seconds, p95Ms: SLO.p95Ms, errorRate: SLO.errorRate },
  soak: { vus: SLO.users / 2, rampSeconds: 300, seconds: 24 * 3_600, p95Ms: SLO.p95Ms, errorRate: SLO.errorRate },
  // A local slice of the soak: 10 minutes at the smoke's size; overrides allowed; never the acceptance soak.
  'soak-slice': { vus: 20, rampSeconds: 10, seconds: 600, p95Ms: SLO.p95Ms, errorRate: SLO.errorRate },
} as const satisfies Record<string, Profile>;
export type ProfileName = keyof typeof PROFILES;

/** The profile that is the acceptance check (S16-01). */
export const ACCEPTANCE_PROFILE: ProfileName = 'staging';
const OVERRIDES = ['VUS', 'DURATION', 'RAMP', 'P95_MS'] as const;
/** Profiles whose numbers are an acceptance check (the 5,000-user run; the 24 h soak): no overrides. */
const FIXED_PROFILES: ReadonlySet<ProfileName> = new Set([ACCEPTANCE_PROFILE, 'soak']);
/** Overrides each profile accepts: the acceptance profiles none, a soak slice anything but the latency budget. */
const ALLOWED: Record<ProfileName, readonly (typeof OVERRIDES)[number][]> = {
  smoke: OVERRIDES,
  staging: [],
  soak: [],
  'soak-slice': ['VUS', 'DURATION', 'RAMP'],
};

const positive = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};

/** The profile named by `PROFILE` (default smoke) with the overrides it allows (`VUS`, `DURATION`, `RAMP`, `P95_MS`). */
export function resolveProfile(env: Record<string, string | undefined>): Profile & { name: ProfileName } {
  const name = (env.PROFILE ?? 'smoke') as ProfileName;
  const base: Profile | undefined = PROFILES[name];
  if (!base) throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}`);
  const refused = OVERRIDES.filter((k) => env[k] !== undefined && env[k] !== '' && !ALLOWED[name].includes(k));
  if (refused.length > 0) {
    throw new Error(
      FIXED_PROFILES.has(name)
        ? `PROFILE=${name} is an acceptance check: no ${refused.join(', ')} override`
        : `PROFILE=${name} takes no ${refused.join(', ')} override`,
    );
  }
  return {
    name,
    vus: positive('VUS', env.VUS) ?? base.vus,
    seconds: positive('DURATION', env.DURATION) ?? base.seconds,
    rampSeconds: env.RAMP === '0' ? 0 : (positive('RAMP', env.RAMP) ?? base.rampSeconds),
    p95Ms: positive('P95_MS', env.P95_MS) ?? base.p95Ms,
    errorRate: base.errorRate,
  };
}

/**
 * Think time between two actions, seconds: 2 to 16 s, most short (a member clicking through lists), mean ≈ 6.7 s.
 * `scale` shortens it (never below 0.5 s) — not used by the acceptance profiles.
 */
export const THINK = { min: 2, spread: 14 } as const;
export const THINK_MEAN_SECONDS = THINK.min + THINK.spread / 3;
export function thinkSeconds(rng: Rng): number {
  return THINK.min + THINK.spread * rng() ** 2;
}

/**
 * Requests the steady phase must send at least: each user one action per (think + a p95-budget answer), at 80 % —
 * an API slower than its budget, or a load generator that cannot keep its users busy, fails the run.
 */
export function minSteadyRequests(p: Profile): number {
  return Math.floor((p.vus * p.seconds * 0.8) / (THINK_MEAN_SECONDS + p.p95Ms / 1_000));
}

/**
 * One `ramping-vus` scenario (closed model): ramp to `vus`, hold them for `seconds`, stop. The script tags every
 * sample `phase: warmup` until the ramp ends and `phase: steady` after (`phaseAt`), so the thresholds judge the hold.
 */
export function scenarios(p: Profile): Record<string, Record<string, unknown>> {
  const stages: { target: number; duration: string }[] = [];
  if (p.rampSeconds > 0) stages.push({ target: p.vus, duration: `${p.rampSeconds}s` });
  stages.push({ target: p.vus, duration: `${p.seconds}s` });
  return {
    dashboard: {
      executor: 'ramping-vus',
      exec: 'dashboard',
      startVUs: p.rampSeconds > 0 ? 0 : p.vus,
      stages,
      // An iteration is one action and its think time: let the last ones finish.
      gracefulRampDown: '30s',
      gracefulStop: '30s',
    },
  };
}

/** The phase of a sample taken `elapsedMs` after the scenario started. */
export const phaseAt = (p: Profile, elapsedMs: number): 'warmup' | 'steady' =>
  elapsedMs < p.rampSeconds * 1_000 ? 'warmup' : 'steady';

/**
 * k6 `thresholds` — the acceptance check as code, judged on the steady phase: p95 under budget overall and per
 * endpoint; failed requests under the error rate; ≥ 99.9 % of checks pass; the users kept busy (`minSteadyRequests`).
 */
export function thresholds(p: Profile): Record<string, string[]> {
  const steady = '{phase:steady}';
  const t: Record<string, string[]> = {
    [`http_req_duration${steady}`]: [`p(95)<${p.p95Ms}`],
    [`http_req_failed${steady}`]: [`rate<${p.errorRate}`],
    [`checks${steady}`]: [`rate>${SLO.checks}`],
    [`http_reqs${steady}`]: [`count>=${minSteadyRequests(p)}`],
  };
  for (const e of ENDPOINTS) {
    t[`http_req_duration{phase:steady,endpoint:${e}}`] = [`p(95)<${p.p95Ms}`];
    // Not a limit: k6 reports a sub-metric only when a threshold names it (requests per endpoint in the summary).
    t[`http_reqs{phase:steady,endpoint:${e}}`] = ['count>=0'];
  }
  return t;
}

export type Rng = () => number;

export const pick = <T>(rng: Rng, xs: readonly T[]): T | undefined =>
  xs.length === 0 ? undefined : xs[Math.floor(rng() * xs.length) % xs.length];

/** Cumulative weights of the mix, in `ENDPOINTS` order. */
export const MIX_CUMULATIVE: readonly number[] = (() => {
  let t = 0;
  return ENDPOINTS.map((e) => {
    t += MIX[e];
    return t;
  });
})();

/** The action a draw `x` in [0, 1) lands on. */
export function actionAt(x: number): Endpoint {
  const i = MIX_CUMULATIVE.findIndex((c) => x < c);
  return ENDPOINTS[i < 0 ? ENDPOINTS.length - 1 : i] as Endpoint;
}

/** A list the VU is paging through: the first page's query (or body), the next cursor and how deep it goes. */
export interface Paging {
  query: string;
  /** Network search: the first page's JSON body (the cursor goes into a copy of it). */
  body?: Record<string, unknown>;
  cursor: string;
  depth: number;
  maxDepth: number;
}

/** What one VU (one member) has seen: ids to open and the lists it is paging through. */
export interface VuState {
  listingIds: string[];
  contactIds: string[];
  paging: Partial<Record<ListKind, Paging>>;
}
export const newVuState = (): VuState => ({ listingIds: [], contactIds: [], paging: {} });
/** Ids a VU keeps per kind (the most recent): a member opens what it just saw. */
export const IDS_KEPT = 50;

export interface Req {
  method: 'GET' | 'POST';
  path: string;
  /** JSON body (`POST`). */
  body?: Record<string, unknown>;
  endpoint: Endpoint;
  /** A list page: the script keeps its body to learn ids and follow its `nextCursor`. */
  list?: ListKind;
  /** A first page (no cursor): its query string, or body, starts a new paging. */
  first?: { query: string; body?: Record<string, unknown> };
}

const qs = (params: [string, string | number][]) =>
  params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

/** Page sizes a dashboard list asks for (the UI's 25 by default, some 50 or 100 — never above `MAX_PAGE_SIZE`). */
const PAGE_SIZES = [25, 25, 25, 25, 50, 50, 100];
const LISTING_SORTS = ['newest', 'newest', 'newest', 'updated', 'price_asc', 'price_desc', 'oldest'];
const LISTING_STATUSES = ['ACTIVE', 'ACTIVE', 'DRAFT', 'UNDER_OFFER'];
const TRANSACTIONS = ['SALE', 'SALE', 'SALE', 'RENT_LONG_TERM'];
const CONTACT_TYPES = ['BUYER', 'BUYER', 'SELLER', 'TENANT', 'LANDLORD'];
const NETWORK_SORTS = ['newest', 'newest', 'price_asc', 'price_desc', 'beds_desc', 'area_desc'];
/** Price bands of a Spanish coast buyer (cents): from-to pairs, either end open. */
const PRICE_BANDS: [number | null, number | null][] = [
  [null, 20_000_000],
  [10_000_000, 30_000_000],
  [20_000_000, 50_000_000],
  [30_000_000, 80_000_000],
  [50_000_000, null],
];

/** Shares of the optional filters on a first page (each drawn on its own). */
export const FILTER_SHARES = { mine: 0.5, status: 0.5, transaction: 0.3, price: 0.25, beds: 0.25, q: 0.1 } as const;

function listingsFirst(rng: Rng): Req {
  const p: [string, string | number][] = [];
  if (rng() < FILTER_SHARES.mine) p.push(['mine', 'true']);
  if (rng() < FILTER_SHARES.status) p.push(['status', pick(rng, LISTING_STATUSES) ?? 'ACTIVE']);
  if (rng() < FILTER_SHARES.transaction) p.push(['transactionType', pick(rng, TRANSACTIONS) ?? 'SALE']);
  if (rng() < FILTER_SHARES.price) {
    const [min, max] = pick(rng, PRICE_BANDS) ?? [null, null];
    if (min !== null) p.push(['priceMin', min]);
    if (max !== null) p.push(['priceMax', max]);
  }
  if (rng() < FILTER_SHARES.beds) p.push(['bedroomsMin', 1 + Math.floor(rng() * 4)]);
  // A reference typed into the box: the start of one (letters and digits only, ≤ 16).
  if (rng() < FILTER_SHARES.q) p.push(['q', String(1 + Math.floor(rng() * 9))]);
  p.push(['sort', pick(rng, LISTING_SORTS) ?? 'newest'], ['limit', pick(rng, PAGE_SIZES) ?? 25]);
  const query = qs(p);
  return {
    method: 'GET',
    path: `/v1/listings?${query}`,
    endpoint: 'listings_list',
    list: 'listings',
    first: { query },
  };
}

function contactsFirst(rng: Rng): Req {
  const p: [string, string | number][] = [];
  if (rng() < 0.5) p.push(['owner', 'me']);
  if (rng() < 0.4) p.push(['type', pick(rng, CONTACT_TYPES) ?? 'BUYER']);
  p.push(['limit', pick(rng, PAGE_SIZES) ?? 25]);
  const query = qs(p);
  return {
    method: 'GET',
    path: `/v1/crm/contacts?${query}`,
    endpoint: 'contacts_list',
    list: 'contacts',
    first: { query },
  };
}

function networkFirst(rng: Rng): Req {
  const body: Record<string, unknown> = { sort: pick(rng, NETWORK_SORTS) ?? 'newest', limit: 24 };
  if (rng() < 0.6) body.transactionType = pick(rng, TRANSACTIONS) ?? 'SALE';
  if (rng() < 0.4) {
    const [min, max] = pick(rng, PRICE_BANDS) ?? [null, null];
    if (min !== null) body.priceMinCents = min;
    if (max !== null) body.priceMaxCents = max;
  }
  if (rng() < 0.4) body.bedsMin = 1 + Math.floor(rng() * 4);
  if (rng() < 0.15) body.newBuilds = true;
  if (rng() < 0.15) body.limit = NETWORK_PAGE_MAX;
  return {
    method: 'POST',
    path: '/v1/network/search',
    body,
    endpoint: 'network_search',
    list: 'network',
    first: { query: '', body },
  };
}

/** The next page of the VU's own paging of `kind`, or undefined (nothing to follow, or deep enough). */
function nextPage(kind: ListKind, s: VuState): Req | undefined {
  const pg = s.paging[kind];
  if (!pg || pg.depth >= pg.maxDepth) return undefined;
  if (kind === 'network') {
    return {
      method: 'POST',
      path: '/v1/network/search',
      body: { ...pg.body, cursor: pg.cursor },
      endpoint: 'network_cursor',
      list: 'network',
    };
  }
  const base = kind === 'listings' ? '/v1/listings' : '/v1/crm/contacts';
  return {
    method: 'GET',
    path: `${base}?${pg.query}&${qs([['cursor', pg.cursor]])}`,
    endpoint: kind === 'listings' ? 'listings_cursor' : 'contacts_cursor',
    list: kind,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

/**
 * The request for one action of a working agent, given what the VU has seen. Detail, timeline and next-page actions
 * fall back to the list's first page while the VU has nothing to open or follow (the member opens the list first).
 */
export function requestFor(action: Endpoint, rng: Rng, s: VuState, nowMs: number): Req {
  switch (action) {
    case 'listings_list':
      return listingsFirst(rng);
    case 'listings_cursor':
      return nextPage('listings', s) ?? listingsFirst(rng);
    case 'listing_detail': {
      const id = pick(rng, s.listingIds);
      return id
        ? { method: 'GET', path: `/v1/listings/${encodeURIComponent(id)}`, endpoint: 'listing_detail' }
        : listingsFirst(rng);
    }
    case 'contacts_list':
      return contactsFirst(rng);
    case 'contacts_cursor':
      return nextPage('contacts', s) ?? contactsFirst(rng);
    case 'contact_detail': {
      const id = pick(rng, s.contactIds);
      return id
        ? { method: 'GET', path: `/v1/crm/contacts/${encodeURIComponent(id)}`, endpoint: 'contact_detail' }
        : contactsFirst(rng);
    }
    case 'contact_timeline': {
      const id = pick(rng, s.contactIds);
      return id
        ? {
            method: 'GET',
            path: `/v1/crm/activities?${qs([
              ['subject', 'CONTACT'],
              ['subjectId', id],
              ['limit', 25],
            ])}`,
            endpoint: 'contact_timeline',
          }
        : contactsFirst(rng);
    }
    case 'activities':
      return { method: 'GET', path: `/v1/crm/activities?${qs([['limit', 25]])}`, endpoint: 'activities' };
    case 'pipeline_board':
      return {
        method: 'GET',
        path: `/v1/crm/pipeline/board?${qs(rng() < 0.6 ? [['assigned', 'me']] : [])}`.replace(/\?$/, ''),
        endpoint: 'pipeline_board',
      };
    case 'leads_list': {
      const p: [string, string | number][] = [];
      if (rng() < 0.6) p.push(['assigned', 'me']);
      p.push(['limit', 25]);
      return { method: 'GET', path: `/v1/crm/leads?${qs(p)}`, endpoint: 'leads_list' };
    }
    case 'tasks_list':
      return {
        method: 'GET',
        path: `/v1/crm/tasks?${qs([
          ['assignee', 'me'],
          ['status', 'OPEN'],
          ['limit', 25],
        ])}`,
        endpoint: 'tasks_list',
      };
    case 'calendar': {
      // This week, from the start of today (UTC): the calendar's week view.
      const from = Math.floor(nowMs / DAY) * DAY;
      return {
        method: 'GET',
        path: `/v1/crm/calendar/events?${qs([
          ['from', iso(from)],
          ['to', iso(from + 7 * DAY)],
          ['limit', 100],
        ])}`,
        endpoint: 'calendar',
      };
    }
    case 'notifications':
      return {
        method: 'GET',
        path: `/v1/notifications?${qs(
          rng() < 0.3
            ? [
                ['unread', 'true'],
                ['limit', 25],
              ]
            : [['limit', 25]],
        )}`,
        endpoint: 'notifications',
      };
    case 'unread_count':
      return { method: 'GET', path: '/v1/notifications/unread-count', endpoint: 'unread_count' };
    case 'network_search':
      return networkFirst(rng);
    case 'network_cursor':
      return nextPage('network', s) ?? networkFirst(rng);
    case 'saved_searches':
      return { method: 'GET', path: '/v1/saved-searches', endpoint: 'saved_searches' };
  }
}

/** One action: a weighted draw over the mix, then its request. */
export const nextRequest = (rng: Rng, s: VuState, nowMs: number): Req => requestFor(actionAt(rng()), rng, s, nowMs);

const keepLast = (into: string[], ids: readonly string[]) => {
  for (const id of ids) {
    const at = into.indexOf(id);
    if (at >= 0) into.splice(at, 1);
    into.push(id);
  }
  if (into.length > IDS_KEPT) into.splice(0, into.length - IDS_KEPT);
};

/**
 * What the VU learns from a list page it asked for (`ids` of its items, its `nextCursor`): ids to open next, and its
 * paging — a first page starts one (pages 2 to 5, most members stop early), a next page moves it on, the end stops it.
 */
export function observe(
  s: VuState,
  req: Req,
  page: { ids: readonly string[]; nextCursor: string | null | undefined },
  rng: Rng,
): void {
  if (!req.list) return;
  if (req.list === 'listings') keepLast(s.listingIds, page.ids);
  if (req.list === 'contacts') keepLast(s.contactIds, page.ids);
  const kind = req.list;
  if (!page.nextCursor) {
    delete s.paging[kind];
    return;
  }
  if (req.first) {
    s.paging[kind] = {
      query: req.first.query,
      ...(req.first.body ? { body: req.first.body } : {}),
      cursor: page.nextCursor,
      depth: 1,
      maxDepth: 2 + Math.floor(rng() ** 2 * 4),
    };
    return;
  }
  const pg = s.paging[kind];
  if (pg) s.paging[kind] = { ...pg, cursor: page.nextCursor, depth: pg.depth + 1 };
}

/**
 * The office address a member's requests come from (`X-Forwarded-For`, behind a proxy the API trusts): one per agency
 * — an agency's members share their office's connection, as in production — in 10.0.0.0/8.
 */
export function officeAddress(agencyOrdinal: number): string {
  const n = (agencyOrdinal % 16_777_214) + 1;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/** Refresh an access token when this many seconds (plus a per-VU jitter up to `jitter`) are left. */
export const TOKEN_REFRESH = { aheadSeconds: 120, jitterSeconds: 60 } as const;
/** Whether a token that expires at `expiresAtMs` is due for a refresh at `nowMs` (`jitter` in [0, 1), per VU). */
export const refreshDue = (expiresAtMs: number, nowMs: number, jitter: number): boolean =>
  expiresAtMs - nowMs < (TOKEN_REFRESH.aheadSeconds + TOKEN_REFRESH.jitterSeconds * jitter) * 1_000;

/**
 * Without a refresh service the tokens must outlive the run: ramp, steady phase and a minute of grace, plus the refresh
 * margin. Returns the problem, or null.
 */
export function tokensLastProblem(p: Profile, expiresAtMs: number, nowMs: number, canRefresh: boolean): string | null {
  if (canRefresh) return null;
  const needMs = (p.rampSeconds + p.seconds + 60 + TOKEN_REFRESH.aheadSeconds + TOKEN_REFRESH.jitterSeconds) * 1_000;
  if (expiresAtMs - nowMs >= needMs) return null;
  return (
    `the tokens expire in ${Math.max(0, Math.round((expiresAtMs - nowMs) / 1_000))} s and the run needs ` +
    `${Math.round(needMs / 1_000)} s: start the refresh service (pnpm perf:load:tokens --serve) or mint them again`
  );
}

interface TrendValues {
  med?: number;
  'p(95)'?: number;
  'p(99)'?: number;
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
  count: number | null;
}

/** The numbers the STATUS entry and the runbook record, from k6's end-of-test summary. */
export function summaryReport(data: SummaryData, p: Profile) {
  const m = data.metrics;
  const ms = (v: number | undefined) => (v === undefined ? null : Math.round(v * 10) / 10);
  const row = (name: string, metric: string, counter?: string): SummaryRow => {
    const v = m[metric]?.values ?? {};
    return {
      name,
      p50: ms(v.med),
      p95: ms(v['p(95)']),
      p99: ms(v['p(99)']),
      count: counter ? (m[counter]?.values.count ?? null) : null,
    };
  };
  const rows: SummaryRow[] = [
    row('all (steady)', 'http_req_duration{phase:steady}', 'http_reqs{phase:steady}'),
    ...ENDPOINTS.map((e) =>
      row(e, `http_req_duration{phase:steady,endpoint:${e}}`, `http_reqs{phase:steady,endpoint:${e}}`),
    ),
  ];
  const requests = m['http_reqs{phase:steady}']?.values.count ?? 0;
  const failedThresholds = Object.entries(m).flatMap(([name, metric]) =>
    Object.entries(metric?.thresholds ?? {})
      .filter(([, t]) => !t.ok)
      .map(([expr]) => `${name} ${expr}`),
  );
  return {
    target: { vus: p.vus, seconds: p.seconds, p95Ms: p.p95Ms, errorRate: p.errorRate },
    requests,
    rps: Math.round((requests / p.seconds) * 10) / 10,
    errorRate: m['http_req_failed{phase:steady}']?.values.rate ?? 0,
    tokenRefreshes: m.token_refreshes?.values.count ?? 0,
    rows,
    failedThresholds,
    pass: failedThresholds.length === 0,
  };
}

/** The summary as text (k6 `handleSummary` stdout). */
export function summaryText(data: SummaryData, p: Profile): string {
  const r = summaryReport(data, p);
  const n = (v: number | null) => (v === null ? '     -' : v.toFixed(1).padStart(6));
  const same = (a: Profile) => p.vus === a.vus && p.seconds === a.seconds && p.p95Ms === a.p95Ms;
  const name = (p as Profile & { name?: ProfileName }).name;
  const label =
    name === 'soak-slice'
      ? ' — a soak slice, NOT the acceptance profile'
      : same(PROFILES[ACCEPTANCE_PROFILE])
        ? ' (the acceptance profile)'
        : same(PROFILES.soak)
          ? ' (the 24-hour soak profile)'
          : ' — NOT the acceptance profile';
  const lines = [
    `dashboard API load test — ${r.target.vus} concurrent users for ${r.target.seconds} s${label}`,
    `  sent ${r.requests} requests in the steady phase = ${r.rps} rps; errors ${(r.errorRate * 100).toFixed(3)} %; token refreshes ${r.tokenRefreshes}`,
    '  latency ms              p50     p95     p99  requests',
    ...r.rows.map((x) => `  ${x.name.padEnd(20)} ${n(x.p50)}  ${n(x.p95)}  ${n(x.p99)}  ${x.count ?? '-'}`),
    r.pass ? '  PASS: every threshold held' : `  FAIL: ${r.failedThresholds.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}
