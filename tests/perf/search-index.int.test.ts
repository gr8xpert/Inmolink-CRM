import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as search from '@inmolink/core/modules/search';
import { loadStackEnv } from '@inmolink/db/testing';
import { createLogger } from '@inmolink/platform/logger';
import {
  createMeiliEngine,
  type Filter,
  meiliSearchBody,
  type SearchEngine,
  type SearchQuery,
} from '@inmolink/platform/search';
import { beforeAll, expect, it } from 'vitest';

/**
 * Listings index at scale (S5-02 acceptance): filter + facet queries answer in p95 < 100 ms, measured at the client
 * (HTTP included), one query at a time. Documents have the shape `search.buildIndexDoc` produces (5,000 agencies, a
 * 4-level location tree, 40 types, 80 features, two locales of text) under the real `search.listingsIndex` settings.
 *
 * The acceptance size is 2,000,000 documents on a staging-sized box (app-1: 64–128 GB): that index is ~11 GB and must
 * sit in the page cache. A dev machine's Docker VM (8 GB) or a CI runner cannot hold it — queries then wait on disk
 * (2026-10-17: p95 395 ms cold vs 2–13 ms per query warm) — so the default here is 500,000 documents (~2.5 GB), and
 * the full check runs on staging: `SEARCH_PERF_DOCS=2000000 pnpm test:perf:root` (STATUS, S5-02).
 *
 * The index persists in the test Meilisearch volume and is loaded only when it does not hold the full set yet
 * (first run ~minutes; later runs only query).
 */

const ROOT = join(import.meta.dirname, '..', '..');
const log = createLogger({ service: 'perf', level: 'info' });
const DOCS = Number(process.env.SEARCH_PERF_DOCS ?? 500_000);
/** Bump when the document shape or settings change: a new index is loaded. */
const SEED_VERSION = 1;
const UID = `perf_listings_${DOCS}_v${SEED_VERSION}`;
const BATCH = 20_000;
const QUERIES = 300;
const P95_BUDGET_MS = 100;

const AGENCIES = 5_000;
const REGIONS = 10;
const CITIES_PER_REGION = 6;
const AREAS_PER_CITY = 5;
const TYPES = 40;
const FEATURES = 80;
const COUNTRY = '0195f000-0000-7000-8000-000000000000';

/** Deterministic ids and values: the same `i` always yields the same document. */
const uuid = (space: number, n: number) =>
  `0195f000-${space.toString(16).padStart(4, '0')}-7000-8000-${n.toString(16).padStart(12, '0')}`;
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4_294_967_296;
  };
}
const region = (r: number) => uuid(1, r);
const city = (c: number) => uuid(2, c);
const area = (a: number) => uuid(3, a);
const agency = (a: number) => uuid(4, a);
const type = (t: number) => uuid(5, t);
const feature = (f: number) => uuid(6, f);
const CITIES = REGIONS * CITIES_PER_REGION;
const WORDS_ES = ['Villa', 'Ático', 'Apartamento', 'Chalet', 'Casa', 'Estudio', 'Dúplex', 'Finca'];
const EXTRAS_ES = ['con piscina', 'con vistas al mar', 'reformado', 'cerca de la playa', 'con jardín', 'de lujo'];
const WORDS_EN = ['Villa', 'Penthouse', 'Apartment', 'Chalet', 'House', 'Studio', 'Duplex', 'Country house'];
const EXTRAS_EN = ['with pool', 'with sea views', 'renovated', 'near the beach', 'with garden', 'luxury'];

function doc(i: number): search.ListingIndexDoc {
  const r = rng(i * 2_654_435_761 + 7);
  const c = Math.floor(r() * CITIES);
  const a = c * AREAS_PER_CITY + Math.floor(r() * AREAS_PER_CITY);
  const w = Math.floor(r() * WORDS_ES.length);
  const x = Math.floor(r() * EXTRAS_ES.length);
  const v = r();
  const features = new Set<string>();
  for (let k = Math.floor(r() * 9); k > 0; k--) features.add(feature(Math.floor(r() * FEATURES)));
  const priceCents = Math.round(Math.exp(11.5 + r() * 2.5)) * 100;
  const onRequest = r() < 0.03;
  return {
    id: uuid(9, i),
    kind: r() < 0.9 ? 'LISTING' : 'UNIT',
    ownerAgencyId: agency(Math.floor(r() * AGENCIES)),
    developmentId: null,
    status: r() < 0.85 ? 'ACTIVE' : r() < 0.5 ? 'UNDER_OFFER' : 'SOLD',
    visibility: v < 0.6 ? 'PUBLIC' : v < 0.95 ? 'SHARED' : 'RESTRICTED',
    shareScope: r() < 0.8 ? 'ALL' : 'PREFERRED',
    transactionType: r() < 0.8 ? 'SALE' : 'RENT_LONG_TERM',
    propertyTypeId: type(Math.floor(r() * TYPES)),
    locationIds: [COUNTRY, region(Math.floor(c / CITIES_PER_REGION)), city(c), area(a)],
    featureIds: [...features].sort(),
    priceCents: onRequest ? null : priceCents,
    priceOnRequest: onRequest,
    beds: Math.floor(r() * 7),
    baths: 1 + Math.floor(r() * 4),
    areaM2: 40 + Math.floor(r() * 460),
    plotM2: r() < 0.4 ? 200 + Math.floor(r() * 3000) : null,
    geo: { lat: 36 + r() * 7, lng: -9 + r() * 12 },
    ref: `R${i}`,
    publishedAt: 1_700_000_000 + Math.floor(r() * 60_000_000),
    version: 1,
    sourceHash: `h${i}`,
    title_es: `${WORDS_ES[w]} ${EXTRAS_ES[x]} en Ciudad ${c}`,
    title_en: `${WORDS_EN[w]} ${EXTRAS_EN[x]} in City ${c}`,
    place_es: `Zona ${a}, Ciudad ${c}, Región ${Math.floor(c / CITIES_PER_REGION)}, España`,
    place_en: `Area ${a}, City ${c}, Region ${Math.floor(c / CITIES_PER_REGION)}, Spain`,
    description_es: `${WORDS_ES[w]} luminoso de ${2 + (i % 4)} dormitorios ${EXTRAS_ES[x]}, a pocos minutos del centro.`,
  };
}

let engine: SearchEngine;
const def = search.listingsIndex(UID);

beforeAll(async () => {
  loadStackEnv('test');
  engine = createMeiliEngine({
    url: process.env.MEILI_URL as string,
    apiKey: process.env.MEILI_MASTER_KEY as string,
    timeoutMs: 120_000,
  });
  await search.ensureListingsIndex(engine, def);
  const stats = await engine.stats(UID);
  if (stats?.documents === DOCS && !stats.indexing) {
    log.info({ uid: UID, documents: DOCS }, 'search perf index already loaded');
    return;
  }
  const started = Date.now();
  let last: { uid: number } | null = null;
  for (let from = 0; from < DOCS; from += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, DOCS - from) }, (_, k) => doc(from + k));
    last = await engine.upsert(UID, batch);
    // Bounded queue: wait for every tenth batch so the engine's queue never holds the whole set in payloads.
    if ((from / BATCH) % 10 === 9) await engine.waitForTask(last, { timeoutMs: 1_800_000 });
  }
  if (last) await engine.waitForTask(last, { timeoutMs: 3_600_000 });
  log.info(
    { uid: UID, documents: DOCS, seconds: Math.round((Date.now() - started) / 1000) },
    'search perf index loaded',
  );
}, 4 * 3_600_000);

function query(i: number): SearchQuery {
  const r = rng(i + 99);
  const c = Math.floor(r() * CITIES);
  const minPrice = Math.round(Math.exp(11.5 + r() * 1.5)) * 100;
  const facets = ['propertyTypeId', 'featureIds', 'beds', 'locationIds'];
  const active: Filter = { op: 'eq', field: 'status', value: 'ACTIVE' };
  switch (i % 4) {
    case 0: // an agency website: its own public listings
      return {
        filter: {
          op: 'and',
          filters: [
            { op: 'eq', field: 'ownerAgencyId', value: agency(Math.floor(r() * AGENCIES)) },
            { op: 'eq', field: 'visibility', value: 'PUBLIC' },
            active,
          ],
        },
        facets,
        sort: [{ field: 'priceCents', dir: 'asc' }],
        limit: 24,
      };
    case 1: // portal: a city, beds and a price band, newest first
      return {
        filter: {
          op: 'and',
          filters: [
            { op: 'eq', field: 'visibility', value: 'PUBLIC' },
            active,
            { op: 'eq', field: 'locationIds', value: city(c) },
            { op: 'range', field: 'beds', gte: 1 + Math.floor(r() * 3) },
            { op: 'range', field: 'priceCents', gte: minPrice, lte: minPrice * 3 },
          ],
        },
        facets,
        sort: [{ field: 'publishedAt', dir: 'desc' }],
        limit: 24,
      };
    case 2: // network search: shared to everyone or by preferring owners, in a region, with a feature
      return {
        filter: {
          op: 'and',
          filters: [
            { op: 'in', field: 'visibility', values: ['PUBLIC', 'SHARED'] },
            {
              op: 'or',
              filters: [
                { op: 'eq', field: 'shareScope', value: 'ALL' },
                {
                  op: 'in',
                  field: 'ownerAgencyId',
                  values: Array.from({ length: 20 }, () => agency(Math.floor(r() * AGENCIES))),
                },
              ],
            },
            { op: 'eq', field: 'transactionType', value: 'SALE' },
            { op: 'eq', field: 'locationIds', value: region(Math.floor(r() * REGIONS)) },
            { op: 'eq', field: 'featureIds', value: feature(Math.floor(r() * FEATURES)) },
          ],
        },
        facets: [...facets, 'visibility'],
        limit: 24,
      };
    default: // text in the visitor's locale, with filters
      return {
        text: `${WORDS_ES[Math.floor(r() * WORDS_ES.length)]} piscina`,
        searchOn: ['ref', 'title_es', 'place_es', 'description_es'],
        locale: 'es',
        filter: {
          op: 'and',
          filters: [
            { op: 'eq', field: 'visibility', value: 'PUBLIC' },
            active,
            { op: 'eq', field: 'locationIds', value: region(Math.floor(r() * REGIONS)) },
          ],
        },
        facets,
        limit: 24,
      };
  }
}

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

/** The test Meilisearch container: requests are timed from inside it, where the apps call it on app-1. */
function meiliContainer(): string {
  const id = execFileSync('docker', ['compose', '--profile', 'test', 'ps', '-q', 'meilisearch-test'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (!id) throw new Error('meilisearch-test is not running (pnpm infra:up:test)');
  return id;
}

/**
 * Times these request bodies one at a time with curl inside the Meilisearch container (ms each). From the host,
 * Docker Desktop's port relay adds ~45 ms to any answer over ~1 KB (2026-10-17: 2–4 ms in the container, 47 ms
 * from Windows for the same query) — a dev-machine artifact, not the engine and not production's path.
 */
function timeInNetwork(bodies: readonly Record<string, unknown>[]): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'search-perf-'));
  try {
    const file = join(dir, 'queries.ndjson');
    writeFileSync(file, `${bodies.map((b) => JSON.stringify(b)).join('\n')}\n`);
    const container = meiliContainer();
    execFileSync('docker', ['cp', file, `${container}:/tmp/search-perf.ndjson`]);
    const script = `while IFS= read -r q; do
      curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -H "Authorization: Bearer $KEY" \
        -H 'Content-Type: application/json' --data-binary "$q" "http://127.0.0.1:7700/indexes/$UID/search"
    done < /tmp/search-perf.ndjson`;
    const out = execFileSync(
      'docker',
      ['exec', '-e', `KEY=${process.env.MEILI_MASTER_KEY}`, '-e', `UID=${UID}`, container, 'sh', '-c', script],
      { encoding: 'utf8', maxBuffer: 10_000_000 },
    );
    return out
      .trim()
      .split('\n')
      .map((line) => {
        const [code, seconds] = line.split(' ');
        if (code !== '200') throw new Error(`search answered ${code}`);
        return Number(seconds) * 1000;
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it(`[S5-02] filter + facet query on ${DOCS.toLocaleString('en')} docs p95 < ${P95_BUDGET_MS} ms`, async () => {
  expect((await engine.stats(UID))?.documents).toBe(DOCS);
  // Through the adapter: every query is valid and most find something (realistic filters).
  let hits = 0;
  const hostMs: number[] = [];
  for (let i = 0; i < QUERIES; i++) {
    const started = performance.now();
    const res = await engine.search(def, query(i));
    hostMs.push(performance.now() - started);
    if (res.total > 0) hits++;
  }
  expect(hits).toBeGreaterThan(QUERIES * 0.5);

  // The budget: the adapter's own requests, timed where production sends them from (warm-up first).
  timeInNetwork(Array.from({ length: 20 }, (_, i) => meiliSearchBody(def, query(1_000 + i))));
  const bodies = Array.from({ length: QUERIES }, (_, i) => meiliSearchBody(def, query(i)));
  const wall = timeInNetwork(bodies);
  const perKind = [0, 1, 2, 3].map((k) => wall.filter((_, i) => i % 4 === k));
  const p95 = percentile(wall, 95);
  log.info(
    {
      documents: DOCS,
      queries: QUERIES,
      p50: Math.round(percentile(wall, 50)),
      p95: Math.round(p95),
      p99: Math.round(percentile(wall, 99)),
      p95ByKind: {
        website: Math.round(percentile(perKind[0] ?? [], 95)),
        portal: Math.round(percentile(perKind[1] ?? [], 95)),
        network: Math.round(percentile(perKind[2] ?? [], 95)),
        text: Math.round(percentile(perKind[3] ?? [], 95)),
      },
      hostClientP95: Math.round(percentile(hostMs, 95)),
      withHits: hits,
    },
    'search perf',
  );
  expect(p95).toBeLessThan(P95_BUDGET_MS);
});
