// Website API load test (S7-08, PLAN §15): search 60 %, detail 30 %, taxonomy / changes 10 % over many sites.
//
//   k6 run -e BASE_URL=https://feed-origin.staging.example -e PROFILE=staging -e KEYS_FILE=keys.json website-api.js
//
// Env: BASE_URL (origin, or the CDN host with EDGE=1), KEYS_FILE (written by `pnpm perf:load:setup`), PROFILE
// (smoke | staging | spike | degraded), RATE, DURATION (s), WARMUP (s), EDGE (1: `_k` on every request, report edge
// hits), P95_MS, DEGRADED (1: the search engine is stopped — every search must come from the Postgres fallback),
// SUMMARY_FILE (k6's summary as JSON). Runbook: docs/runbooks/website-api.md › Load test.
import { check } from 'k6';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import http from 'k6/http';
import { Rate } from 'k6/metrics';
import {
  cumulative,
  DEGRADED_METRIC,
  detailRequest,
  edgeToken,
  keysNeeded,
  MIX,
  maxKeyShare,
  nextPageQuery,
  otherRequest,
  pick,
  pickWeighted,
  resolveProfile,
  scenarios,
  searchRequest,
  siteWeights,
  startSession,
  summaryText,
  thresholds,
  withEdgeToken,
} from './lib/website-mix.ts';

const profile = resolveProfile(__ENV);
const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:4001').replace(/\/$/, '');
/** `{ keys: [{ key, siteId, policy, locales }], limits }` — secrets: keep the file off the repo (`tests/load/.data/`). */
const KEYS = JSON.parse(open(__ENV.KEYS_FILE || './.data/website-keys.json'));

export const options = {
  scenarios: scenarios(profile),
  thresholds: thresholds(profile),
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Bodies only where a request asks for them (setup, cursors to follow): the load generator stays small.
  discardResponseBodies: true,
  // A load generator's own DNS cache would pin one origin IP; follow the record like browsers and servers do.
  dns: { ttl: '1m', select: 'random' },
  setupTimeout: '5m',
  userAgent: 'inmolink-load-test/S7-08 (k6)',
};

const edgeHits = new Rate('edge_hits');
/** Searches answered by the Postgres fallback (`degraded: true`, S7-F9); a threshold in the degraded profile. */
const searchDegraded = new Rate(DEGRADED_METRIC);
const rng = Math.random;
let failuresLogged = 0;

const headersFor = (key) => ({ 'X-Api-Key': key, 'Accept-Encoding': 'gzip' });

/** One measured request; `body`: keep the answer (to follow its `nextCursor`), else it is discarded. */
function get(site, path, endpoint, body = false) {
  const url = `${BASE_URL}${profile.edge ? withEdgeToken(path, site.k) : path}`;
  const res = http.get(url, {
    headers: headersFor(site.key),
    tags: { endpoint, name: endpoint },
    ...(body ? { responseType: 'text' } : {}),
  });
  const cache = res.headers['Cf-Cache-Status'];
  if (profile.edge) edgeHits.add(cache === 'HIT' || cache === 'STALE' || cache === 'REVALIDATED');
  if (res.status !== 200 && res.status !== 304 && failuresLogged < 5) {
    // A few per VU, so a failing run says which endpoint and status without flooding the output; a 429 names the
    // limit's scope (S7-F9: ip, key, tenant, browser) and its code (RATE_LIMITED or QUOTA_EXCEEDED).
    failuresLogged++;
    let limit = '';
    if (res.status === 429) {
      try {
        const err = JSON.parse(String(res.body ?? '{}')).error ?? {};
        limit = ` ${err.code ?? ''} scope=${err.details?.scope ?? '?'}`;
      } catch {
        limit = ' (no JSON body)';
      }
    }
    console.warn(`${endpoint} ${res.status}${limit} ${res.headers['X-Request-Id'] ?? ''} ${path.slice(0, 160)}`);
  }
  check(res, {
    'status 200 or 304': (r) => r.status === 200 || r.status === 304,
    // Origin mode measures the origin: an answer from a CDN cache would flatter the numbers.
    'served by the origin': () => profile.edge || cache === undefined || cache === 'DYNAMIC' || cache === 'BYPASS',
  });
  return res;
}

function json(site, path) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: headersFor(site.key),
    responseType: 'text',
    tags: { phase: 'setup' },
  });
  if (res.status !== 200) {
    console.warn(`setup ${path}: ${res.status}`);
    return null;
  }
  return JSON.parse(res.body);
}

/**
 * Learns each site the way a website would: its sitemap (references for detail pages), first pages of a few
 * searches (location and type ids, coordinates, page-2 queries with their cursors) and a change-feed cursor. Sites are
 * drawn Zipf-weighted (a few busy ones, a long tail), each capped below its key's limits.
 */
export function setup() {
  const sites = KEYS.keys;
  const seconds = profile.seconds + profile.warmupSeconds;
  const needed = keysNeeded(profile.rate, seconds, KEYS.limits);
  if (sites.length < needed) {
    exec.test.abort(
      `${sites.length} load-test keys for ${profile.rate} rps: ${needed} needed so no limit trips (pnpm perf:load:setup --sites ${needed})`,
    );
  }
  // Every VU holds a copy of the pools: fewer references per site the more sites there are.
  const refsPerSite = Math.max(20, Math.min(300, Math.floor(20_000 / sites.length)));
  const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const pools = sites.map((s) => {
    const site = { ...s, k: edgeToken(s.key, '', (x) => crypto.sha256(x, 'base64rawurl')) };
    const pool = { refs: [], locations: [], types: [], langs: s.locales, pages: [], changeCursors: [], points: [] };
    const map = json(site, `/v2/sitemap?limit=${refsPerSite}`);
    for (const e of map?.items ?? []) pool.refs.push(e.ref);
    for (const q of ['sort=newest', 'sort=price_asc', 'bedsMin=2', 'transaction=RENT_LONG_TERM']) {
      const page = json(site, `/v2/listings?${q}&limit=24`);
      if (!page) continue;
      if (page.nextCursor) pool.pages.push(nextPageQuery(`${q}&limit=24`, page.nextCursor));
      for (const c of page.items) {
        for (const t of [c.place?.region, c.place?.city])
          if (t?.id && !pool.locations.includes(t.id)) pool.locations.push(t.id);
        if (c.propertyType?.id && !pool.types.includes(c.propertyType.id)) pool.types.push(c.propertyType.id);
        if (c.geo && pool.points.length < 50) pool.points.push([c.geo.lat, c.geo.lng]);
      }
    }
    const changes = json(site, `/v2/changes?since=${encodeURIComponent(since)}&limit=200`);
    if (changes?.nextCursor) pool.changeCursors.push(changes.nextCursor);
    return { site, pool };
  });
  if (!pools.some((p) => p.pool.refs.length > 0)) exec.test.abort('no site shows any listing: seed and rebuild first');
  const share = maxKeyShare(profile.rate, seconds, KEYS.limits);
  let weights;
  try {
    weights = siteWeights(pools.length, share);
  } catch (err) {
    exec.test.abort(String(err));
  }
  const refs = pools.reduce((n, p) => n + p.pool.refs.length, 0);
  console.log(
    `setup: ${pools.length} sites (Zipf, busiest ${(weights[0] * 100).toFixed(1)} % ≤ ${(share * 100).toFixed(1)} %), ` +
      `${refs} references, profile ${profile.name} at ${profile.rate} rps`,
  );
  return { pools, cum: cumulative(weights) };
}

/** A site drawn by its weight (`withRefs`: one that shows listings, for detail pages). */
function drawSite(d, withRefs = false) {
  for (let i = 0; i < 10; i++) {
    const p = d.pools[pickWeighted(rng, d.cum)];
    if (!withRefs || p.pool.refs.length > 0) return p;
  }
  return pick(
    rng,
    d.pools.filter((p) => p.pool.refs.length > 0),
  );
}

// Per VU: the visitor's current search (followed by its `nextCursor`) and each site's change cursor (a plugin polling).
let session;
const changeCursors = {};

const nextCursorOf = (res) => {
  if (res.status !== 200) return null;
  try {
    return res.json('nextCursor') ?? null;
  } catch {
    return null;
  }
};

export function search(d) {
  const { site, pool } = drawSite(d);
  const own = session && session.siteId === site.siteId ? session : undefined;
  const r = searchRequest(rng, pool, own);
  const res = get(site, r.path, r.endpoint, true);
  if (res.status === 200) {
    let degraded = false;
    try {
      degraded = res.json('degraded') === true;
    } catch {
      // not JSON: counted as not degraded
    }
    searchDegraded.add(degraded);
  }
  const next = nextCursorOf(res);
  if (r.query) {
    const started = startSession(rng, r.query, next);
    session = started ? { ...started, siteId: site.siteId } : undefined;
  } else if (own && r.path.includes(own.cursor)) {
    session = next ? { ...own, cursor: next, depth: own.depth + 1 } : undefined;
  }
}

export function detail(d) {
  const { site, pool } = drawSite(d, true);
  const r = detailRequest(rng, pool);
  get(site, r.path, r.endpoint);
}

export function other(d) {
  const { site, pool } = drawSite(d);
  const r = otherRequest(rng, pool, Date.now(), changeCursors[site.siteId]);
  const changes = r.endpoint !== 'taxonomy';
  const res = get(site, r.path, r.endpoint, changes);
  if (changes) {
    const next = nextCursorOf(res);
    if (next) changeCursors[site.siteId] = next;
  }
}

/** The warm-up ramp: the same mix, one scenario. */
export function mixed(d) {
  const x = rng();
  if (x < MIX.search) search(d);
  else if (x < MIX.search + MIX.detail) detail(d);
  else other(d);
}

export function handleSummary(data) {
  const out = { stdout: summaryText(data, profile) };
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(data);
  return out;
}
