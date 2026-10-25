import type { PublicListingSearch } from '@inmolink/contracts';
import { MATCH_GLOBAL_CONCURRENCY } from '@inmolink/core/modules/network';
import * as search from '@inmolink/core/modules/search';
import { loadStackEnv } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureSearch, createMeiliEngine, type SearchEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Buyer-request matching beside website search (S12-F5): `search.matchListingOwners` runs facet rounds with a growing
 * exclusion list on the Meilisearch that answers feed-api's `/v2/listings`. `NETWORK_CONTENTION_DOCS` listing
 * documents (default 200,000, a tenth of PLAN §1's 2M — the full index does not fit this machine, S5-02; H4 runs it at
 * size) over 400 owner agencies, half of them PUBLIC, go into a Meilisearch index of their own. Website searches
 * (`search.searchPublicListings`, as feed-api calls it, with the engine's slow threshold raised so the Postgres hedge
 * cannot hide engine latency) are measured alone, then while 50 buyer requests matching every owner (two or three
 * rounds each) run through `MATCH_GLOBAL_CONCURRENCY` slots — the job's pool-wide cap. No database rows: the engine is
 * the contended resource.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const RUN = newId().slice(-8);
/** `NETWORK_CONTENTION_KEEP=1`: a fixed index kept between runs (loaded once; tuning runs skip the 4-minute load). */
const KEEP = process.env.NETWORK_CONTENTION_KEEP === '1';
const UID = KEEP ? 'perf_netmatch_kept' : `perf_netmatch_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const DOCS = Number(process.env.NETWORK_CONTENTION_DOCS ?? 200_000);
const OWNERS = 400;
const BUYER_REQUESTS = 50;
/** Concurrent website visitors' searches during the matching burst. */
const CLIENTS = 8;
const BASELINE_QUERIES = 200;
const P95_BUDGET_MS = 150;
const BATCH = 10_000;
/** The job's pool-wide cap (`NETWORK_CONTENTION_CAP` tries another). */
const CAP = Number(process.env.NETWORK_CONTENTION_CAP ?? MATCH_GLOBAL_CONCURRENCY);

const country = newId();
const regions = Array.from({ length: 8 }, () => newId());
const types = Array.from({ length: 6 }, () => newId());
const owners = Array.from({ length: OWNERS }, () => newId());
const LOCALE = 'en';

let engine: SearchEngine;
let saved: ReturnType<typeof search.websiteSearchSettings>;

const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.ceil(xs.length * 0.95) - 1] as number;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Listing documents as the indexer writes them (filter fields, one locale's texts). */
function docsFrom(start: number, count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = start; i < start + count; i++) {
    const region = regions[i % regions.length] as string;
    out.push({
      id: `0195f0a5-0501-7000-8000-${i.toString(16).padStart(12, '0')}`,
      kind: 'LISTING',
      ownerAgencyId: owners[i % OWNERS],
      developmentId: null,
      status: i % 10 === 0 ? 'SOLD' : 'ACTIVE',
      visibility: i % 2 === 0 ? 'PUBLIC' : 'SHARED',
      shareScope: 'ALL',
      allowedAgencyIds: [],
      networkHidden: false,
      preferredAgencyIds: [],
      transactionType: i % 4 === 0 ? 'RENT_LONG_TERM' : 'SALE',
      propertyTypeId: types[i % types.length],
      locationIds: [country, region],
      featureIds: [],
      priceCents: 15_000_000 + (i % 400) * 500_000,
      priceOnRequest: false,
      beds: i % 6,
      baths: 1 + (i % 3),
      areaM2: 60 + (i % 300),
      plotM2: null,
      geo: { lat: 36 + (i % 100) * 0.05, lng: -6 + (i % 80) * 0.05 },
      ref: `NM${i}`,
      publicCode: `PC${i}`,
      commissionBp: 500,
      publishedAt: 1_700_000_000_000 + i * 1_000,
      version: 1,
      sourceHash: 'perf',
      [`title_${LOCALE}`]: `Villa ${i % 997} with sea views`,
      [`place_${LOCALE}`]: `Region ${i % regions.length}`,
      [`description_${LOCALE}`]: 'A bright home close to the beach and the town centre.',
    });
  }
  return out;
}

/** Visitor searches like the website plugin's: a network-wide or own site, filters and sorts varying. */
const visitorSearch = (i: number) => {
  const site: search.PublicSearchSite =
    i % 3 === 0
      ? { ownerAgencyIds: null, requestId: `perf-${i}` }
      : { ownerAgencyIds: [owners[i % OWNERS] as string], requestId: `perf-${i}` };
  const q: PublicListingSearch = {
    locale: LOCALE,
    statuses: ['ACTIVE'],
    ...(i % 2 === 0 ? { transactionType: 'SALE' as const } : {}),
    ...(i % 4 === 1 ? { locationIds: [regions[i % regions.length] as string] } : {}),
    ...(i % 5 === 2 ? { propertyTypeIds: [types[i % types.length] as string], bedsMin: 2 } : {}),
    ...(i % 7 === 3 ? { priceMinCents: 30_000_000, priceMaxCents: 120_000_000 } : {}),
    sort: (['newest', 'price_asc', 'price_desc'] as const)[i % 3],
    limit: 24,
  } as PublicListingSearch;
  return { site, q };
};

async function timedSearch(i: number): Promise<number> {
  const { site, q } = visitorSearch(i);
  const t0 = performance.now();
  const r = await search.searchPublicListings(site, q, { engine });
  const ms = performance.now() - t0;
  // the engine answered (the fallback would hide what the engine costs)
  if (r.backend !== 'engine') throw new Error(`search ${i} answered by ${r.backend}`);
  return ms;
}

const MATCH_QUERY = {
  transactionType: 'SALE' as const,
  locationIds: [country],
  priceMinCents: 15_000_000,
  priceMaxCents: 250_000_000,
};

/** A buyer request matching listings of every owner but its own (two or three facet rounds). */
const buyerRequest = (n: number) =>
  search.matchListingOwners(MATCH_QUERY, { excludeAgencyId: owners[n % OWNERS] as string, perAgency: 10, engine });

/** `requests` buyer requests through `slots` at a time, while `CLIENTS` visitors search; their latencies. */
async function underMatching(slots: number): Promise<{ times: number[]; matchMs: number; owners: number }> {
  let done = false;
  let next = 0;
  let matched = 0;
  const t0 = performance.now();
  const matching = (async () => {
    await Promise.all(
      Array.from({ length: slots }, async () => {
        for (let n = next++; n < BUYER_REQUESTS; n = next++) {
          const r = await buyerRequest(n);
          matched = Math.max(matched, r.owners.length);
        }
      }),
    );
    done = true;
  })();
  const times: number[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      while (!done) times.push(await timedSearch(i++));
    }),
  );
  await matching;
  return { times, matchMs: performance.now() - t0, owners: matched };
}

beforeAll(async () => {
  loadStackEnv('test');
  engine = createMeiliEngine({
    url: process.env.MEILI_URL as string,
    apiKey: process.env.MEILI_MASTER_KEY as string,
    timeoutMs: 120_000,
  });
  configureSearch(engine);
  search.configureSearchIndex({ uid: UID, scope: [] });
  saved = { ...search.websiteSearchSettings() };
  search.configureWebsiteSearch({ slowMs: 30_000, engineTimeoutMs: 60_000 });
  search.resetSearchBreaker({ failureThreshold: 1_000_000 });
  const started = Date.now();
  await search.ensureListingsIndex(engine, search.listingsIndex(UID));
  if ((await engine.stats(UID))?.documents !== DOCS) {
    let last = null;
    for (let i = 0; i < DOCS; i += BATCH) last = await engine.upsert(UID, docsFrom(i, Math.min(BATCH, DOCS - i)));
    await engine.waitForTask(last, { timeoutMs: 1_800_000 });
  }
  // warm the index's caches the way a live engine is
  for (let i = 0; i < 50; i++) await timedSearch(i);
  // one buyer request alone, each engine call timed (facet / sample / owners)
  const calls: Record<string, number[]> = { facet: [], sample: [], fetch: [] };
  const timing: SearchEngine = {
    ...engine,
    search: async (def, q) => {
      const t = performance.now();
      const r = await engine.search(def, q);
      calls[q.facets ? 'facet' : 'sample']?.push(Math.round(performance.now() - t));
      return r;
    },
    fetch: async (uid, ids, fields) => {
      const t = performance.now();
      const r = await engine.fetch(uid, ids, fields);
      calls.fetch?.push(Math.round(performance.now() - t));
      return r;
    },
  };
  const m0 = performance.now();
  const first = await search.matchListingOwners(MATCH_QUERY, {
    excludeAgencyId: owners[0] as string,
    perAgency: 10,
    engine: timing,
  });
  log.info({ ms: Math.round(performance.now() - m0), owners: first.owners.length, calls }, 'one buyer request alone');
  log.info(
    { docs: DOCS, owners: OWNERS, seconds: Math.round((Date.now() - started) / 1000) },
    'contention index loaded',
  );
}, 1_800_000);

afterAll(async () => {
  if (saved) search.configureWebsiteSearch(saved);
  search.resetSearchBreaker();
  if (!KEEP) await engine?.dropIndex(UID);
});

it('[S12-F5] 50 concurrent buyer requests keep website search p95 < 150 ms (matching capped pool-wide)', async () => {
  const alone: number[] = [];
  for (let i = 0; i < BASELINE_QUERIES; i++) alone.push(await timedSearch(1_000 + i));
  const capped = await underMatching(CAP);
  const report = {
    docs: DOCS,
    cap: CAP,
    aloneP95Ms: round1(p95(alone)),
    cappedP95Ms: round1(p95(capped.times)),
    cappedSearches: capped.times.length,
    matchSeconds: round1(capped.matchMs / 1000),
    ownersMatched: capped.owners,
  };
  log.info(report, 'website search beside buyer-request matching');
  // more owners than one 200-value facet: every request takes more than one round
  expect(capped.owners).toBeGreaterThan(200);
  expect(capped.times.length).toBeGreaterThanOrEqual(100);
  expect(report.aloneP95Ms).toBeLessThan(P95_BUDGET_MS);
  expect(report.cappedP95Ms).toBeLessThan(P95_BUDGET_MS);
}, 1_800_000);
