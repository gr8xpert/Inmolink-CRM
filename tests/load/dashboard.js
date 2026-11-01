// Dashboard API load test (S16-01, PLAN §15 "Dashboard: 5,000 concurrent users; API p95 < 300 ms"): closed model —
// every VU is one scale-seed member working the dashboard (listings, contacts, CRM, notifications, network search),
// thinking 2–16 s between actions and following its lists' cursors. Mix, profiles and thresholds: lib/dashboard-mix.ts.
//
//   k6 run -e BASE_URL=https://api.staging.example -e PROFILE=staging -e USERS_FILE=users.json dashboard.js
//
// Env: BASE_URL (the API origin), USERS_FILE (written by `pnpm perf:load:tokens`; default ./.data/dashboard-users.json),
// PROFILE (smoke | staging | soak | soak-slice), VUS, DURATION (s), RAMP (s), P95_MS (smoke only; staging and soak take
// no override; soak-slice — NOT the acceptance soak — takes VUS, DURATION and RAMP),
// TOKENS_REFRESH_URL (the refresh service as this load generator reaches it, else the file's `refresh.url`),
// CLIENT_IPS (default 1: `X-Forwarded-For` = the member's office address, one per agency — only an API that trusts one
// proxy hop reads it; 0: none), SUMMARY_FILE (k6's summary as JSON), CALENDAR_FROM / CALENDAR_TO (ISO: the seeded
// calendar span, default the users file's `calendarWindow`).
//
// Tokens: the API takes 15-minute Bearer tokens (audience `api`) only. The users file carries one per member, minted
// by `identity.issueAccessToken` (the service behind the web app's `/session/token`); for anything longer than one
// token lifetime, `pnpm perf:load:tokens --serve` runs a refresh service and each VU fetches its member's new token
// 2–3 minutes before expiry (`GET <refresh>/tokens/<index>`, Bearer the file's per-run secret) — the web app's own
// refresh needs an Auth.js browser session per member, which k6 cannot hold for 5,000 accounts without driving the
// sign-in form (see scripts/perf/load-tokens.ts). Refresh requests are tagged `phase: auth`: never judged.
// Runbook: docs/runbooks/load-suite.md › Dashboard.
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import {
  itemCount,
  LIST_PAGES,
  LIST_PAGES_WITH_ITEMS,
  newVuState,
  nextRequest,
  observe,
  phaseAt,
  refreshDue,
  resolveProfile,
  scenarios,
  summaryText,
  thinkSeconds,
  thresholds,
  tokensLastProblem,
} from './lib/dashboard-mix.ts';

const profile = resolveProfile(__ENV);
const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
/** `{ users: [{ agencyId, userId, api, realtime, index, office }], issuedAt, expiresAt, refresh }` — secrets. */
const FILE = JSON.parse(open(__ENV.USERS_FILE || './.data/dashboard-users.json'));
const REFRESH_URL = (__ENV.TOKENS_REFRESH_URL || FILE.refresh?.url || '').replace(/\/$/, '');
const REFRESH_SECRET = FILE.refresh?.secret || '';
const CLIENT_IPS = __ENV.CLIENT_IPS !== '0';
// S16-F4: the span the members' agencies have seeded calendar events in (the users file's; CALENDAR_FROM / CALENDAR_TO,
// ISO, override it): the calendar action asks for a week inside it, so an old seed still answers a full week.
const CAL_FROM = __ENV.CALENDAR_FROM || FILE.calendarWindow?.from;
const CAL_TO = __ENV.CALENDAR_TO || FILE.calendarWindow?.to;
const CALENDAR = CAL_FROM && CAL_TO ? { fromMs: Date.parse(CAL_FROM), toMs: Date.parse(CAL_TO) } : null;

export const options = {
  scenarios: scenarios(profile),
  thresholds: thresholds(profile),
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Bodies only of list pages (ids to open, cursors to follow) and of the CRM pages whose items are counted (S16-F4).
  discardResponseBodies: true,
  dns: { ttl: '1m', select: 'random' },
  userAgent: 'inmolink-load-test/S16-01 (k6)',
};

const tokenRefreshes = new Counter('token_refreshes');
// S16-F4: CRM pages answered, and those with items (perf:smoke fails on an endpoint whose pages were all empty)
const listPages = new Counter(LIST_PAGES);
const listPagesWithItems = new Counter(LIST_PAGES_WITH_ITEMS);
const rng = Math.random;
let failuresLogged = 0;

export function setup() {
  const users = FILE.users ?? [];
  if (users.length === 0) exec.test.abort('the users file holds no users: pnpm perf:load:tokens first');
  // The acceptance and soak runs are N concurrent members, not N tabs of fewer.
  if (users.length < profile.vus && profile.name !== 'smoke') {
    exec.test.abort(`${users.length} users for ${profile.vus} VUs: pnpm perf:load:tokens --users ${profile.vus}`);
  }
  const problem = tokensLastProblem(
    profile,
    Date.parse(FILE.expiresAt),
    Date.now(),
    Boolean(REFRESH_URL && REFRESH_SECRET),
  );
  if (problem) exec.test.abort(problem);
  console.log(
    `setup: ${users.length} members of ${new Set(users.map((u) => u.agencyId)).size} agencies, profile ${profile.name} ` +
      `at ${profile.vus} VUs, token refresh ${REFRESH_URL ? 'on' : 'off'}`,
  );
}

// Per VU: its member, its token and what it has seen (ids to open, cursors to follow).
let me;
let token;
let tokenExpiresAt = 0;
const jitter = rng();
const state = newVuState();

function refreshToken(force) {
  if (!force && !refreshDue(tokenExpiresAt, Date.now(), jitter)) return;
  if (!REFRESH_URL || !REFRESH_SECRET) {
    if (Date.now() >= tokenExpiresAt) exec.test.abort('access tokens expired and no refresh service is configured');
    return;
  }
  const tags = exec.vu.metrics.tags;
  const phase = tags.phase;
  tags.phase = 'auth';
  const res = http.get(`${REFRESH_URL}/tokens/${me.index}`, {
    headers: { Authorization: `Bearer ${REFRESH_SECRET}` },
    responseType: 'text',
    tags: { endpoint: 'token_refresh', name: 'token_refresh' },
  });
  tags.phase = phase;
  if (res.status === 200) {
    const body = res.json();
    token = body.api;
    tokenExpiresAt = Date.parse(body.expiresAt);
    tokenRefreshes.add(1);
  } else if (failuresLogged < 5) {
    failuresLogged++;
    console.warn(`token refresh for member ${me.index}: ${res.status}`);
  }
}

export function dashboard() {
  if (!me) {
    me = FILE.users[(exec.vu.idInTest - 1) % FILE.users.length];
    token = me.api;
    tokenExpiresAt = Date.parse(FILE.expiresAt);
  }
  exec.vu.metrics.tags.phase = phaseAt(profile, Date.now() - exec.scenario.startTime);
  refreshToken(false);

  const req = nextRequest(rng, state, Date.now(), CALENDAR);
  const headers = { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' };
  if (CLIENT_IPS && me.office) headers['X-Forwarded-For'] = me.office;
  if (req.body) headers['Content-Type'] = 'application/json';
  const res = http.request(req.method, `${BASE_URL}${req.path}`, req.body ? JSON.stringify(req.body) : null, {
    headers,
    tags: { endpoint: req.endpoint, name: req.endpoint },
    ...(req.list || req.items ? { responseType: 'text' } : {}),
  });
  if (res.status !== 200 && failuresLogged < 5) {
    failuresLogged++;
    let code = '';
    try {
      code = ` ${JSON.parse(String(res.body ?? '{}')).error?.code ?? ''}`;
    } catch {
      // body discarded or not JSON
    }
    console.warn(`${req.endpoint} ${res.status}${code} ${res.headers['X-Request-Id'] ?? ''} ${req.path.slice(0, 160)}`);
  }
  check(res, { 'status 200': (r) => r.status === 200 });
  // A token the API refused (expired between the check and the request, or revoked): fetch a new one now.
  if (res.status === 401) refreshToken(true);
  if (req.items && res.status === 200) {
    let n = 0;
    try {
      n = itemCount(req.endpoint, res.json());
    } catch {
      // not JSON: no items
    }
    listPages.add(1, { endpoint: req.endpoint });
    listPagesWithItems.add(n > 0 ? 1 : 0, { endpoint: req.endpoint });
  }
  if (req.list && res.status === 200) {
    let ids = [];
    let nextCursor = null;
    try {
      ids = req.list === 'network' ? [] : (res.json('items.#.id') ?? []);
      nextCursor = res.json('nextCursor') ?? null;
    } catch {
      // not JSON: nothing learned
    }
    observe(state, req, { ids, nextCursor }, rng);
  }
  sleep(thinkSeconds(rng));
}

export function handleSummary(data) {
  const out = { stdout: summaryText(data, profile) };
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(data);
  return out;
}
