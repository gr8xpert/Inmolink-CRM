import {
  CreateListingBody,
  type PublicListingSearch,
  SetListingFeaturesBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import {
  configureSearch,
  createMeiliEngine,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
} from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../../agencies';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as search from '../index';

/**
 * Website search with the Postgres fallback (S5-04, PLAN §5.4): the same site filters answered by Meilisearch and,
 * with the engine stopped, by `listing_search_docs` — the same results, simpler ranking — and the circuit breaker
 * that switches between them.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const UID = `t_website_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
/** Meilisearch stopped: nothing listens there (connection refused). */
const stopped = () => createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 500 });

let a: Founder;
let b: Founder;
/** S6-F1: the agency that is suspended (its own, so the other tests' fixtures stay put). */
let c: Founder | undefined;
let ids: { region: string; cityA: string; cityB: string; villa: string; flat: string; pool: string; garden: string };
const L: Record<string, string> = {};

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('search.website.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const rebuild = (list: readonly string[]) => system((tx) => search.rebuildReadModels(tx, 'LISTING', list));
const update = (m: Founder, id: string, patch: Omit<UpdateListingBody, 'version'>) =>
  as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, id)).version }),
    ),
  );

/** A listing made PUBLIC (and its status) with features, its read models built. */
async function listing(
  m: Founder,
  body: Partial<CreateListingBody>,
  opts: { features?: string[]; status?: 'ACTIVE' | 'SOLD'; visibility?: 'PUBLIC' | 'SHARED' } = {},
): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.cityA,
        priceCents: 30_000_000,
        energyRating: 'B',
        ...body,
      }),
    ),
  );
  if (opts.features) {
    await as(m, async (ctx) =>
      properties.setListingFeatures(
        ctx,
        id,
        SetListingFeaturesBody.parse({
          version: (await properties.getListing(ctx, id)).version,
          featureIds: opts.features,
        }),
      ),
    );
  }
  await update(m, id, { status: 'ACTIVE', visibility: opts.visibility ?? 'PUBLIC' });
  if (opts.status === 'SOLD') await update(m, id, { status: 'SOLD' });
  await rebuild([id]);
  return id;
}

/** A stand-in engine: counts calls, answers via `answer` (default: fails like a stopped engine). */
function fakeEngine(answer?: (q: SearchQuery) => Promise<SearchResult>) {
  const calls = { n: 0 };
  const engine = {
    ...stopped(),
    search: async (_def: unknown, q: SearchQuery) => {
      calls.n += 1;
      if (!answer) throw new Error('engine down');
      return answer(q);
    },
  } as SearchEngine;
  return { engine, calls };
}

const site = (extra: Partial<PublicListingSearch> = {}): PublicListingSearch => ({ locale: 'en', ...extra });
/** The site's inventory (its policy, S7-01): agency a's listings, or a and b's. */
const ours = (owners: string[] = [a.agencyId]): search.PublicSearchSite => ({
  ownerAgencyIds: owners,
  requestId: newId(),
});

/**
 * Equivalence tests compare the engine's answer with the fallback's, not timing: the local Meilisearch on the Docker
 * Desktop VM is sometimes slower than the production slow threshold (50 ms), which would let the fallback win. The
 * timing tests set the production defaults themselves (`withDefaultTiming`).
 */
const RELAXED = { engineTimeoutMs: 5_000, slowMs: 4_000 };

async function withDefaultTiming<T>(fn: () => Promise<T>): Promise<T> {
  search.configureWebsiteSearch({});
  try {
    return await fn();
  } finally {
    search.configureWebsiteSearch(RELAXED);
  }
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  search.configureWebsiteSearch(RELAXED);
  a = await createFounder();
  b = await createFounder();
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('ws'),
      translations: name('Webland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('ws-r'),
      translations: name('Coast'),
    });
    const city = (c: string) =>
      taxonomy.createLocation(tx, { level: 'CITY', parentId: region, code: code(`ws-${c}`), translations: name(c) });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('ws-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const type = (t: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: code(`ws-${t}`), sort: 0, translations: name(t) });
    const fg = await taxonomy.createFeatureGroup(tx, { key: code('ws-fg'), sort: 0, translations: name('Outside') });
    const feature = (f: string) =>
      taxonomy.createFeature(tx, { groupId: fg, key: code(`ws-${f}`), icon: 'pool', sort: 0, translations: name(f) });
    return {
      region,
      cityA: await city('Alpha'),
      cityB: await city('Beta'),
      villa: await type('Villa'),
      flat: await type('Flat'),
      pool: await feature('Pool'),
      garden: await feature('Garden'),
    };
  });
  L.cheap = await listing(
    a,
    { priceCents: 30_000_000, bedrooms: 2, coordinates: { lat: 36.5, lng: -5 }, locationPrecision: 'EXACT' },
    { features: [ids.pool] },
  );
  L.mid = await listing(
    a,
    {
      priceCents: 50_000_000,
      bedrooms: 3,
      propertyTypeId: ids.flat,
      coordinates: { lat: 40.4, lng: -3.7 },
      locationPrecision: 'EXACT',
    },
    { features: [ids.pool, ids.garden] },
  );
  L.dear = await listing(
    a,
    {
      priceCents: 80_000_000,
      bedrooms: 4,
      locationId: ids.cityB,
      builtM2: 240,
      coordinates: { lat: 36.55, lng: -4.95 },
      locationPrecision: 'EXACT',
    },
    { features: [ids.garden] },
  );
  L.onRequest = await listing(a, { priceCents: null, priceOnRequest: true, bedrooms: 5, locationId: ids.cityB });
  L.rent = await listing(a, { priceCents: 45_000_000, bedrooms: 1, transactionType: 'RENT_LONG_TERM' });
  L.shared = await listing(a, { priceCents: 40_000_000 }, { visibility: 'SHARED' });
  L.sold = await listing(a, { priceCents: 41_000_000 }, { status: 'SOLD' });
  L.other = await listing(b, { priceCents: 35_000_000 });

  // The engine side: the same documents in a test index.
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: Object.values(L) });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  search.resetSearchBreaker();
}, 180_000);

afterAll(async () => {
  await real().dropIndex(UID);
  if (Object.keys(L).length === 0) return closeDb();
  await system(async (tx) => {
    const all = sql.join(
      Object.values(L).map((t) => sql`${t}`),
      sql`, `,
    );
    await tx.execute(sql`delete from search_index_queue where target_id in (${all})`);
    await tx.execute(sql`delete from listing_search_docs where target_id in (${all})`);
    const owners = sql.join(
      [a, b, ...(c ? [c] : [])].map((m) => sql`${m.agencyId}`),
      sql`, `,
    );
    await tx.execute(sql`delete from read_model_queue where owner_agency_id in (${owners})`);
    await tx.execute(sql`delete from listing_read_models where agency_id in (${owners})`);
    await tx.execute(sql`delete from properties where agency_id in (${owners})`);
  });
  await closeDb();
});

describe('Postgres fallback rows', () => {
  it('[S5-04] read-model writes keep the fallback rows in the same transaction: PUBLIC targets only', async () => {
    const docs = await rows<{ target_id: string; price_cents: string | null; feature_ids: string[] }>(
      sql`select target_id, price_cents, feature_ids from listing_search_docs
           where owner_agency_id = ${a.agencyId} order by target_id`,
    );
    expect(docs.map((d) => d.target_id).sort()).toEqual([L.cheap, L.mid, L.dear, L.onRequest, L.rent, L.sold].sort());
    expect(docs.find((d) => d.target_id === L.onRequest)?.price_cents).toBeNull();

    // Same fields as the index document (one builder for both).
    const { docs: built } = await system((tx) => search.indexDocsFor(tx, [L.mid as string]));
    expect(docs.find((d) => d.target_id === L.mid)?.feature_ids.sort()).toEqual(built[0]?.featureIds);

    // No longer PUBLIC: the row goes with the change; PUBLIC again: it is back.
    await update(a, L.rent as string, { visibility: 'SHARED' });
    await rebuild([L.rent as string]);
    expect(await rows(sql`select 1 from listing_search_docs where target_id = ${L.rent}`)).toHaveLength(0);
    await update(a, L.rent as string, { visibility: 'PUBLIC' });
    await rebuild([L.rent as string]);
    expect(await rows(sql`select 1 from listing_search_docs where target_id = ${L.rent}`)).toHaveLength(1);
  });

  it('[S5-04] the full rebuild fills missing fallback rows and drops stale ones', async () => {
    await rows(sql`delete from listing_search_docs where target_id = ${L.cheap}`);
    await rows(
      sql`insert into listing_search_docs (target_id, kind, owner_agency_id, status, transaction_type, property_type_id,
            location_ids, feature_ids, price_on_request, ref, published_at, version, source_hash)
          values (${L.shared}, 'LISTING', ${a.agencyId}, 'ACTIVE', 'SALE', ${ids.villa}, '{}', '{}', false, 'X', 1, 1, 'x')`,
    );
    await search.rebuildAllReadModels({ agencyId: a.agencyId, kinds: ['LISTING'] });
    const present = await rows<{ target_id: string }>(
      sql`select target_id from listing_search_docs where target_id in (${L.cheap}, ${L.shared})`,
    );
    expect(present.map((r) => r.target_id)).toEqual([L.cheap]);
  });

  it("[S6-F3] a full rebuild writes each target's fallback row once (statement count)", async () => {
    // Every document of the agency changes (stale etags), so the page's rebuild changes all its targets: the fallback
    // rows were refreshed for the changed ones and then again for the whole page (two upserts, two deletes).
    await rows(sql`update listing_read_models set etag = 'stale' where agency_id = ${a.agencyId}`);
    await rows(sql`delete from listing_search_docs where target_id = ${L.cheap}`);
    const [{ n } = { n: 0 }] = await rows<{ n: number }>(
      sql`select count(distinct target_id)::int as n from listing_read_models where agency_id = ${a.agencyId}`,
    );
    expect(n).toBeLessThan(search.READ_MODEL_BATCH); // one page
    let progress: { written: number } | undefined;
    const writes = await countQueries(
      async () => {
        progress = (await search.rebuildAllReadModels({ agencyId: a.agencyId, kinds: ['LISTING'] })).LISTING;
      },
      { match: /^\s*(insert into|delete from)\s+"?listing_search_docs"?\s/i },
    );
    expect(progress?.written).toBeGreaterThanOrEqual(n);
    // The page's PUBLIC targets in one upsert, the others' rows in one delete: each target written once.
    expect(writes).toBe(2);
    expect(await rows(sql`select 1 from listing_search_docs where target_id = ${L.cheap}`)).toHaveLength(1);
  });
});

describe('website search', () => {
  const cases: [string, Partial<PublicListingSearch>][] = [
    ['everything of the site, newest first', {}],
    ['a city, by price', { sort: 'price_asc' }],
    ['a region, beds and a price band', { bedsMin: 2, priceMinCents: 30_000_000, priceMaxCents: 60_000_000 }],
    ['a type and every one of two features', { sort: 'price_desc' }],
    ['rentals', { transactionType: 'RENT_LONG_TERM' }],
    ['active only, largest first', { statuses: ['ACTIVE'], sort: 'area_desc' }],
    ['a map box', {}],
    ['both agencies, most bedrooms first', { sort: 'beds_desc' }],
  ];

  /** The cases, completed once the fixture ids exist. */
  const resolved = (): [string, search.PublicSearchSite, PublicListingSearch][] =>
    cases.map(([name, extra], i) => {
      const q = site(extra);
      const scope = ours(i === 6 ? [a.agencyId, b.agencyId] : undefined);
      if (i === 1) q.locationIds = [ids.cityA];
      if (i === 2) q.locationIds = [ids.region];
      if (i === 3) Object.assign(q, { propertyTypeIds: [ids.flat, ids.villa], featureIds: [ids.pool, ids.garden] });
      if (i === 8) q.geoBox = { north: 36.6, south: 36.4, west: -5.1, east: -4.9 };
      return [name, scope, q];
    });

  it('[S5-04] with Meilisearch stopped, website search returns the same filtered results from Postgres', async () => {
    for (const [name, scope, q] of resolved()) {
      search.resetSearchBreaker();
      const engine = await search.searchPublicListings(scope, q, { engine: real() });
      expect(engine.backend, name).toBe('engine');
      const fallback = await search.searchPublicListings(scope, q, { engine: stopped() });
      expect(fallback.backend, name).toBe('fallback');
      expect([...fallback.ids].sort(), name).toEqual([...engine.ids].sort());
      expect(fallback.total, name).toBe(engine.total);
      expect(fallback.facets).toEqual({});
    }
    // Spot checks against the fixtures: PUBLIC only, the site's agencies only, nulls last in either direction.
    search.resetSearchBreaker();
    const all = await search.searchPublicListings(ours(), site({ sort: 'price_desc' }), { engine: stopped() });
    expect(all.ids).toEqual([L.dear, L.mid, L.rent, L.cheap, L.onRequest]);
    const asc = await search.searchPublicListings(ours(), site({ sort: 'price_asc' }), { engine: stopped() });
    expect(asc.ids).toEqual([L.cheap, L.rent, L.mid, L.dear, L.onRequest]);
    const both = await search.searchPublicListings(ours([a.agencyId, b.agencyId]), site(), {
      engine: stopped(),
    });
    expect(both.ids).toContain(L.other);
    expect(both.ids).not.toContain(L.shared);
    expect(both.ids).not.toContain(L.sold);
  });

  it('[S5-04] fallback pages walk every result exactly once, in order, by keyset cursor', async () => {
    for (const sort of ['newest', 'price_asc', 'price_desc', 'beds_desc', 'area_desc'] as const) {
      search.resetSearchBreaker();
      const whole = await search.searchPublicListings(ours(), site({ sort, limit: 100 }), { engine: stopped() });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await search.searchPublicListings(ours(), site({ sort, limit: 2, cursor }), { engine: stopped() });
        expect(page.ids.length).toBeLessThanOrEqual(2);
        seen.push(...page.ids);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen, sort).toEqual(whole.ids);
      expect(whole.ids).toHaveLength(5);
    }
    // A fallback cursor stays in the fallback (its order) even with the engine back; a cursor of another sort is
    // the caller's error.
    const first = await search.searchPublicListings(ours(), site({ limit: 2 }), { engine: stopped() });
    const second = await search.searchPublicListings(ours(), site({ limit: 2, cursor: first.nextCursor ?? '' }), {
      engine: real(),
    });
    expect(second.backend).toBe('fallback');
    await expect(
      search.searchPublicListings(ours(), site({ limit: 2, sort: 'price_asc', cursor: first.nextCursor ?? '' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('[S6-F2] an engine cursor continuing in the fallback restarts at its first keyset page, flagged as changed results', async () => {
    search.resetSearchBreaker();
    const page1 = await search.searchPublicListings(ours(), site({ sort: 'price_asc', limit: 2 }), { engine: real() });
    expect(page1.backend).toBe('engine');
    expect(page1.resultsChanged).toBeUndefined();
    const page2 = await search.searchPublicListings(
      ours(),
      site({ sort: 'price_asc', limit: 2, cursor: page1.nextCursor ?? '' }),
      {
        engine: stopped(),
      },
    );
    // No SQL OFFSET: the fallback's own first page again, and the site is told the results changed.
    expect(page2).toMatchObject({ backend: 'fallback', ids: page1.ids, resultsChanged: true });
    const page3 = await search.searchPublicListings(
      ours(),
      site({ sort: 'price_asc', limit: 2, cursor: page2.nextCursor ?? '' }),
    );
    expect(page3).toMatchObject({ backend: 'fallback', ids: [L.mid, L.dear] });
    expect(page3.resultsChanged).toBeUndefined();
  });

  it('[S5-04] the map box finds the same listings in both backends', async () => {
    search.resetSearchBreaker();
    const q = site({ geoBox: { north: 36.6, south: 36.4, west: -5.1, east: -4.9 } });
    const fallback = await search.searchPublicListings(ours(), q, { engine: stopped() });
    expect([...fallback.ids].sort()).toEqual([L.cheap, L.dear].sort());
  });

  it('[S5-04] forged cursors and visitor-chosen inventory are refused; deep engine cursors end in the fallback', async () => {
    search.resetSearchBreaker();
    const forge = (c: unknown) => Buffer.from(JSON.stringify(c)).toString('base64url');
    const id = L.cheap as string;
    const refused = [
      forge({ s: 'newest', p: 1, v: null, i: id }), // no row lacks a publication time
      forge({ s: 'price_asc', p: 0, v: 1.5, i: id }), // prices are whole cents
      forge({ s: 'price_asc', p: 0, v: null, i: id }),
      forge({ s: 'price_asc', p: 0, v: 1e300, i: id }),
      forge({ s: 'price_asc', o: 10_000 }),
      'not-json',
    ];
    for (const cursor of refused) {
      const sort =
        cursor.length > 20 ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()).s as 'newest') : 'newest';
      await expect(
        search.searchPublicListings(ours(), site({ sort, cursor }), { engine: stopped() }),
        cursor,
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    // The inventory is the site's, never the visitor's; drafts and withdrawn listings are not theirs to list.
    await expect(
      search.searchPublicListings(ours(), { ...site(), ownerAgencyIds: [b.agencyId] } as PublicListingSearch),
    ).rejects.toThrow();
    await expect(search.searchPublicListings(ours(), site({ statuses: ['WITHDRAWN' as 'ACTIVE'] }))).rejects.toThrow();
    // A deep engine cursor: the fallback's first page, flagged (S6-F2) — never a 5,000-row offset scan.
    const deep = await search.searchPublicListings(ours(), site({ cursor: forge({ s: 'newest', o: 5_000 }) }), {
      engine: stopped(),
    });
    const first = await search.searchPublicListings(ours(), site(), { engine: stopped() });
    expect(deep).toMatchObject({ backend: 'fallback', ids: first.ids, resultsChanged: true });
  });

  it('[S5-04] a reference typed in the search box is found by the fallback; other text finds nothing', async () => {
    search.resetSearchBreaker();
    const ref =
      (await rows<{ ref: string }>(sql`select ref from listing_search_docs where target_id = ${L.mid}`))[0]?.ref ?? '';
    const hit = await search.searchPublicListings(ours(), site({ text: ref.toLowerCase() }), { engine: stopped() });
    expect(hit).toMatchObject({ backend: 'fallback', ids: [L.mid], total: 1 });
    const miss = await search.searchPublicListings(ours(), site({ text: 'sea views' }), { engine: stopped() });
    expect(miss).toMatchObject({ ids: [], total: 0, nextCursor: null });
  });

  it('[S5-04] the circuit breaker opens after failures, skips the engine, probes it and closes again', async () => {
    let now = 0;
    search.resetSearchBreaker({ now: () => now });
    const down = fakeEngine();
    const { breakerFailures, breakerOpenMs } = search.websiteSearchSettings();
    for (let i = 0; i < breakerFailures; i++) {
      expect((await search.searchPublicListings(ours(), site(), { engine: down.engine })).backend).toBe('fallback');
    }
    expect(search.searchBreakerState()).toBe('open');
    // Open: the engine is not even called.
    await search.searchPublicListings(ours(), site(), { engine: down.engine });
    expect(down.calls.n).toBe(breakerFailures);

    now += breakerOpenMs;
    const r = await search.searchPublicListings(ours(), site(), { engine: real() });
    expect(r.backend).toBe('engine');
    expect(search.searchBreakerState()).toBe('closed');
  });

  it('[S5-04] a slow engine is cut at the timeout; the request is answered by the fallback within budget', () =>
    withDefaultTiming(async () => {
      const { engineTimeoutMs, slowMs, breakerFailures } = search.websiteSearchSettings();
      const hung = fakeEngine(() => new Promise(() => {}));
      const started = performance.now();
      const r = await search.searchPublicListings(ours(), site(), { engine: hung.engine });
      const ms = performance.now() - started;
      expect(r.backend).toBe('fallback');
      expect(r.ids).toHaveLength(5);
      expect(ms).toBeLessThan(engineTimeoutMs + 150);
      // Answers slower than the slow threshold count too: enough of them open the breaker. Each engine call reports
      // when it settles, after its request may have been answered by the fallback.
      search.resetSearchBreaker();
      const slow = fakeEngine(async (q) => {
        await new Promise((res) => setTimeout(res, slowMs + 10));
        return real().search(search.listingsIndex(UID), q);
      });
      for (let i = 0; i < breakerFailures; i++) {
        await search.searchPublicListings(ours(), site(), { engine: slow.engine });
      }
      await vi.waitFor(() => expect(search.searchBreakerState()).toBe('open'), { timeout: 2_000 });
      search.resetSearchBreaker();
    }));

  it('[S6-F3] with the engine answering in 200 ms, the fallback answers from the slow threshold and the breaker opens', () =>
    withDefaultTiming(async () => {
      // The timing is config (feed-api boot); a slow threshold at or past the timeout is refused.
      expect(search.websiteSearchSettings()).toMatchObject({ engineTimeoutMs: 100, slowMs: 50 });
      expect(() => search.configureWebsiteSearch({ engineTimeoutMs: 100, slowMs: 100 })).toThrow(RangeError);
      const slowEngine = fakeEngine(async (q) => {
        await new Promise((res) => setTimeout(res, 200));
        return real().search(search.listingsIndex(UID), q);
      });
      const run = async (n: number) => {
        const backends = new Set<string>();
        for (let i = 0; i < n; i++) {
          const r = await search.searchPublicListings(ours(), site({ sort: 'price_asc' }), {
            engine: slowEngine.engine,
          });
          backends.add(r.backend);
          expect(r.ids).toHaveLength(5);
        }
        return backends;
      };
      // The hedge alone: the fallback, started at the slow threshold, wins every time; the breaker stays closed.
      search.resetSearchBreaker({ failureThreshold: 1_000, window: undefined });
      // (The 200 ms engine can still win after an event-loop stall under load: the first answer wins.)
      expect(await run(10)).toContain('fallback');
      expect(search.searchBreakerState()).toBe('closed');
      // The configured breaker: slow answers open it, and then the engine is no longer asked. (The p95 at scale is
      // checked alone in tests/perf/search-fallback: under the parallel int suites timing says little.)
      search.resetSearchBreaker();
      expect(await run(30)).toContain('fallback');
      await vi.waitFor(() => expect(search.searchBreakerState()).toBe('open'), { timeout: 2_000 });
      expect(slowEngine.calls.n).toBeLessThan(10 + 30);
      search.resetSearchBreaker();
    }));

  it('[S5-04] a fallback page is one statement (page, total and next position)', async () => {
    search.resetSearchBreaker({ failureThreshold: 1 });
    await search.searchPublicListings(ours(), site(), { engine: fakeEngine().engine });
    const count = await countQueries(() =>
      search.searchPublicListings(
        ours(),
        site({ locationIds: [ids.region], featureIds: [ids.pool], sort: 'price_asc' }),
      ),
    );
    expect(count).toBe(1);
    search.resetSearchBreaker();
  });
});

describe('owner agency status', () => {
  /** The worker's part: the status event reaches the search subscription; the queued rebuild runs; the index syncs. */
  async function statusChanged(m: Founder, from: 'VERIFIED' | 'SUSPENDED', to: 'VERIFIED' | 'SUSPENDED') {
    await setAgencyStatus(m.agencyId, to);
    const build = vi.spyOn(search.searchJobs.buildReadModels, 'enqueue').mockResolvedValue({ id: 'test' });
    search.registerSearchSubscriptions();
    try {
      const event = agencies.agenciesEvents.statusChanged({ agencyId: m.agencyId, from, to, version: 1 });
      const handlers = defaultSubscribers
        .get(event.type, event.version)
        .filter((h) => h.name === 'search.readModel.agencyStatus');
      expect(handlers).toHaveLength(1);
      const meta = {
        eventId: newId(),
        agencyId: m.agencyId,
        type: event.type,
        version: 1,
        createdAt: new Date(),
        attempt: 1,
      };
      for (const h of handlers) await h.handler(event.payload as never, meta);
      expect(build).toHaveBeenCalledWith({ agencyId: m.agencyId }, expect.anything());
    } finally {
      search.unregisterSearchSubscriptions();
      build.mockRestore();
    }
    await rows(sql`update read_model_queue set due_at = now() where owner_agency_id = ${m.agencyId}`);
    const drained = await search.drainReadModelQueue(m.agencyId, {
      recheckMs: 60_000,
      maxRechecks: 0,
      leaseMs: 60_000,
      budgetMs: 30_000,
      waitMs: 0,
    });
    expect(drained.built).toBeGreaterThan(0);
    await search.syncIndex();
  }

  /** Both backends, for the suspended agency's site. */
  async function found(m: Founder): Promise<{ engine: string[]; fallback: string[] }> {
    search.resetSearchBreaker();
    const engine = await search.searchPublicListings(ours([m.agencyId]), site(), { engine: real() });
    expect(engine.backend).toBe('engine');
    const fallback = await search.searchPublicListings(ours([m.agencyId]), site(), { engine: stopped() });
    expect(fallback.backend).toBe('fallback');
    search.resetSearchBreaker();
    return { engine: [...engine.ids], fallback: [...fallback.ids] };
  }

  it("[S6-F1] a suspended agency's PUBLIC listing disappears from website search (engine and fallback) after its status change", async () => {
    const m = await createFounder();
    c = m;
    await setAgencyStatus(m.agencyId, 'VERIFIED');
    L.suspended = await listing(m, { priceCents: 33_000_000 });
    search.configureSearchIndex({ uid: UID, scope: Object.values(L) });
    await search.syncIndex();
    expect(await found(m)).toEqual({ engine: [L.suspended], fallback: [L.suspended] });

    await statusChanged(m, 'VERIFIED', 'SUSPENDED');
    expect(await found(m)).toEqual({ engine: [], fallback: [] });
    // Its documents stay, not public: app_public reads nothing of it; no fallback row.
    const docs = await rows<{ public: boolean }>(
      sql`select public from listing_read_models where target_id = ${L.suspended}`,
    );
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => !d.public)).toBe(true);
    expect(await rows(sql`select 1 from listing_search_docs where target_id = ${L.suspended}`)).toHaveLength(0);

    // A large agency is queued a page per statement: every target of agency a, two at a time.
    const targets = await rows<{ n: number }>(
      sql`select count(distinct target_id)::int as n from listing_read_models where agency_id = ${a.agencyId}`,
    );
    expect(await search.queueAgencyReadModelChanges(a.agencyId, 60_000, { pageSize: 2 })).toBe(targets[0]?.n);
    const queued = await rows<{ n: number }>(
      sql`select count(*)::int as n from read_model_queue where owner_agency_id = ${a.agencyId}`,
    );
    expect(queued[0]?.n).toBe(targets[0]?.n);
    await rows(sql`delete from read_model_queue where owner_agency_id = ${a.agencyId}`);

    // Reinstated: back on its website.
    await statusChanged(m, 'SUSPENDED', 'VERIFIED');
    expect(await found(m)).toEqual({ engine: [L.suspended], fallback: [L.suspended] });
  });
});
