import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withPublicRead, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { newId } from '@inmolink/platform/ids';
import type { SearchEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import { publicFallbackCondition } from '../../search/testing';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as dedupe from '../index';
import * as repo from '../repo';
import type { PairSignals } from '../scoring';
import { signatureOf } from '../signature';

/**
 * Canonical-only client outputs (R2-03c) on the real test database: one cluster of three PUBLIC listings of three
 * agencies — `b1` pinned canonical but shared PREFERRED with nobody (network sites never see it), `a1` and `c1` shared
 * with every agency — then every client-facing read: website search (engine page hydrated, Postgres fallback), lists,
 * sitemaps, the change feed, selections / PDFs, and agents' "listed by N agencies". Every site is narrowed to this run's
 * city, so no statement walks the global tables.
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const code = (s: string) => `${s}-dc-${RUN}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('dedupe.canonical.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

let A: Founder;
let B: Founder;
let C: Founder;
let D: Founder;
let ids: { city: string; villa: string };
let a1: string;
let b1: string;
let c1: string;
let lone: string;
const mine: string[] = [];
const started = new Date(Date.now() - 60_000);

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

/** An ACTIVE PUBLIC listing of `f` in this run's city, its read models and signature. */
async function listing(f: Founder, shareScope: 'ALL' | 'PREFERRED', priceCents = 50_000_000): Promise<string> {
  const version = async (id: string) => (await as(f, (ctx) => properties.getListing(ctx, id))).version;
  const { id } = await as(f, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents,
        bedrooms: 3,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
      }),
    ),
  );
  await as(f, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ status: 'ACTIVE', visibility: 'PUBLIC', shareScope, version: await version(id) }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  mine.push(id);
  const sig = signatureOf({
    listingId: id,
    ownerAgencyId: f.agencyId,
    version: 1,
    transactionType: 'SALE',
    propertyTypeId: ids.villa,
    locationIds: [ids.city],
    beds: 3,
    baths: 2,
    areaM2: 120,
    priceCents,
    geo: null,
    images: [],
  });
  await system((tx) => repo.upsertSignatures(tx, [sig]));
  return id;
}

const SIGNALS: PairSignals = { images: 1, phash: 1, geo: 1, type: 1, beds: 1, baths: 1, area: 1, price: 1, text: null };

async function pair(x: [string, Founder], y: [string, Founder], score: number, version = 1) {
  const [[a, fa], [b, fb]] = x[0] < y[0] ? [x, y] : [y, x];
  await system((tx) =>
    repo.upsertPairs(tx, [
      {
        listingA: a,
        listingB: b,
        agencyA: fa.agencyId,
        agencyB: fb.agencyId,
        score,
        signals: SIGNALS,
        scorerVersion: 1,
        versionA: version,
        versionB: version,
      },
    ]),
  );
}

/** A site narrowed to this run's city (`requestId` for the logs). */
const site = (s: Omit<search.PublicSearchSite, 'requestId' | 'restrict'>): search.PublicSearchSite => ({
  ...s,
  restrict: { locationIds: [ids.city] },
  requestId: `dc-${RUN}`,
});
const NETWORK_WIDE = () => site({ ownerAgencyIds: [A.agencyId, B.agencyId, C.agencyId] });
const MIXED_A = () => site({ ownerAgencyIds: [A.agencyId], networkOf: A.agencyId, networkRefPrefix: 'AA' });
const NETWORK_D = () => site({ ownerAgencyIds: [D.agencyId], networkOf: D.agencyId, networkRefPrefix: 'DD' });
const OWN_C = () => site({ ownerAgencyIds: [C.agencyId] });

/**
 * An engine that answers every listing of the run in the site's inventory, as the real one would (it knows no
 * clusters: every member comes back, hydration drops the ones the site does not show).
 */
const engineOf = (s: search.PublicSearchSite): SearchEngine =>
  ({
    search: async () => {
      const cond = publicFallbackCondition(s, { locale: L, limit: 50 });
      const found = cond
        ? await rows<{ target_id: string }>(
            sql`select target_id from listing_search_docs where target_id = any(${uuids(mine)}) and ${cond}`,
          )
        : [];
      const inInventory = new Set(found.map((r) => r.target_id));
      const ids = mine.filter((id) => inInventory.has(id));
      return { ids, total: ids.length, facets: {} };
    },
  }) as unknown as SearchEngine;
const ENGINE: unique symbol = Symbol('engine');
const downEngine = (): SearchEngine =>
  ({
    search: async () => {
      throw new Error('engine down');
    },
  }) as unknown as SearchEngine;

/** One page of the site's search: the engine's (hydrated as feed-api does) or the fallback's. */
async function shown(s: search.PublicSearchSite, engine: SearchEngine | typeof ENGINE): Promise<string[]> {
  search.resetSearchBreaker();
  const found = await search.searchPublicListings(
    s,
    { locale: L, limit: 50 },
    { engine: engine === ENGINE ? engineOf(s) : engine },
  );
  const docs = await search.withSiteRead(s, (tx) => search.publicSiteDocs(tx, s, found.ids, 'card', L, L));
  const byId = new Set(docs.map((d) => d.targetId));
  return found.ids.filter((id) => byId.has(id));
}

const cluster = () => new Set([a1, b1, c1]);
const membersShown = (list: readonly string[]) => list.filter((id) => cluster().has(id));

beforeAll(async () => {
  await setupTestDb('worker');
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
    embedOrigin: 'https://sites.inmolink.test',
  });
  [A, B, C, D] = await Promise.all([createFounder(), createFounder(), createFounder(), createFounder()]);
  for (const f of [A, B, C, D]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: code(x.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Canonland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Canonshire'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Canonton'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  a1 = await listing(A, 'ALL');
  b1 = await listing(B, 'PREFERRED', 49_000_000);
  c1 = await listing(C, 'ALL', 51_000_000);
  lone = await listing(A, 'ALL', 90_000_000);
  await pair([a1, A], [b1, B], 0.96);
  await pair([b1, B], [c1, C], 0.95);
  await pair([a1, A], [c1, C], 0.95);
  // b1 is the canonical (a staff pin): the first in rank order, but no network site may show it
  await system((tx) => repo.insertPin(tx, b1, newId(), [a1, c1]));
  await dedupe.recluster([a1]);
}, 240_000);

afterAll(async () => {
  if (mine.length > 0) {
    await rows(sql`delete from dedupe_clusters where id in
      (select cluster_id from dedupe_cluster_members where listing_id = any(${uuids(mine)}))`);
    await rows(
      sql`delete from dedupe_pair_decisions where listing_a = any(${uuids(mine)}) or listing_b = any(${uuids(mine)})`,
    );
    await rows(sql`delete from dedupe_canonical_pins where listing_id = any(${uuids(mine)})`);
    await rows(
      sql`delete from dedupe_pair_scores where listing_a = any(${uuids(mine)}) or listing_b = any(${uuids(mine)})`,
    );
    await rows(sql`delete from dedupe_listing_signatures where listing_id = any(${uuids(mine)})`);
  }
  await closeDb();
});

describe('canonical-only client outputs (R2-03c)', () => {
  it('[R2-03c] refresh on cluster change: the recluster pass writes cluster and rank onto read models and fallback rows', async () => {
    const members = await rows<{ listing_id: string; cluster_id: string; rank: number }>(sql`
      select listing_id, cluster_id, rank from dedupe_cluster_members where listing_id = any(${uuids([a1, b1, c1])})
       order by rank`);
    expect(members.map((m) => m.listing_id)[0]).toBe(b1);
    expect(members).toHaveLength(3);
    const docs = await rows<{ target_id: string; cluster_id: string | null; cluster_rank: number | null }>(sql`
      select target_id, cluster_id, cluster_rank from listing_search_docs where target_id = any(${uuids(mine)})`);
    const models = await rows<{ target_id: string; cluster_id: string | null; cluster_rank: number | null }>(sql`
      select target_id, cluster_id, cluster_rank from listing_read_models where target_id = any(${uuids(mine)})`);
    for (const m of members) {
      expect(docs.find((d) => d.target_id === m.listing_id)).toMatchObject({
        cluster_id: m.cluster_id,
        cluster_rank: m.rank,
      });
      for (const r of models.filter((x) => x.target_id === m.listing_id)) {
        expect(r).toMatchObject({ cluster_id: m.cluster_id, cluster_rank: m.rank });
      }
    }
    expect(docs.find((d) => d.target_id === lone)).toMatchObject({ cluster_id: null, cluster_rank: null });
    // what websites show of the members changed: change log and `search.publicDocs.changed` in the same transaction
    const events = await rows<{ n: number }>(sql`
      select count(*)::int as n from outbox_events where type = 'search.publicDocs.changed'
         and payload->'targetIds' ?| ${`{${[a1, b1, c1].join(',')}}`}::text[] and created_at >= ${started.toISOString()}::timestamptz`);
    expect(events[0]?.n).toBeGreaterThan(0);
    // a rescore of an unchanged listing writes nothing and emits nothing new
    const before = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where type = 'search.publicDocs.changed' and payload->'targetIds' ? ${a1}`);
    await dedupe.rescoreListings([a1, b1, c1]);
    const after = await rows<{ n: number }>(sql`select count(*)::int as n from outbox_events
      where type = 'search.publicDocs.changed' and payload->'targetIds' ? ${a1}`);
    expect(after[0]?.n).toBe(before[0]?.n);
    // a cleared copy (a row rebuilt without one) comes back with the next rescore of the listing
    await rows(sql`update listing_search_docs set cluster_id = null, cluster_rank = null where target_id = ${c1}`);
    await dedupe.rescoreListings([c1]);
    const back = await rows<{ cluster_id: string | null }>(
      sql`select cluster_id from listing_search_docs where target_id = ${c1}`,
    );
    expect(back[0]?.cluster_id).toBe(members[0]?.cluster_id);
  }, 120_000);

  it('[R2-03] client-facing outputs never show two members of one cluster: feed API search (engine page)', async () => {
    const page = await shown(NETWORK_WIDE(), ENGINE);
    expect(membersShown(page)).toEqual([b1]);
    expect(page).toContain(lone);
  }, 60_000);

  it('[R2-03] client-facing outputs never show two members of one cluster: feed API list (Postgres fallback)', async () => {
    const page = await shown(NETWORK_WIDE(), downEngine());
    expect(membersShown(page)).toEqual([b1]);
    expect(page).toContain(lone);
  }, 60_000);

  it('[R2-03c] per-viewer visible canonical: own member first on a mixed site; the best visible member elsewhere', async () => {
    const ranks = new Map(
      (
        await rows<{ listing_id: string; rank: number }>(
          sql`select listing_id, rank from dedupe_cluster_members where listing_id = any(${uuids([a1, c1])})`,
        )
      ).map((r) => [r.listing_id, r.rank]),
    );
    const bestOfAC = (ranks.get(a1) ?? 0) < (ranks.get(c1) ?? 0) ? a1 : c1;
    for (const engine of [ENGINE, downEngine()] as (SearchEngine | typeof ENGINE)[]) {
      // A's site with network listings: its own member, though b1 is canonical and c1 is on its network
      expect(membersShown(await shown(MIXED_A(), engine))).toEqual([a1]);
      // D's network site cannot show b1 (preferred by nobody): the better ranked of a1 / c1
      expect(membersShown(await shown(NETWORK_D(), engine))).toEqual([bestOfAC]);
      // C's own site: its own member, the only one its inventory holds
      expect(membersShown(await shown(OWN_C(), engine))).toEqual([c1]);
    }
  }, 120_000);

  it('[R2-03] client-facing outputs never show two members of one cluster: sitemap and change feed', async () => {
    for (const [s, expected] of [
      [NETWORK_WIDE(), b1],
      [MIXED_A(), a1],
    ] as const) {
      const map = await search.withSiteRead(s, (tx) =>
        search.sitemapPage(tx, s, { limit: 100, locale: L, fallback: L, part: 'none' }),
      );
      expect(membersShown(map.map((r) => r.targetId))).toEqual([expected]);
    }
    // the change feed says a member the site does not show is not present (the site drops its copy)
    const s = NETWORK_WIDE();
    const changes = await search.withSiteRead(s, (tx) =>
      search.siteChanges(tx, s, { since: started, audience: { ownerAgencyId: A.agencyId }, limit: 500 }),
    );
    const ofA1 = changes.rows.filter((r) => r.targetId === a1);
    expect(ofA1.length).toBeGreaterThan(0);
    expect(ofA1.every((r) => !r.present)).toBe(true);
    expect(changes.rows.filter((r) => r.targetId === lone).every((r) => r.present)).toBe(true);
  }, 60_000);

  it('[R2-03] client-facing outputs never show two members of one cluster: selection client view and PDFs', async () => {
    // A's agent added all three: A presents its own member only (b1 is not presentable by A: preferred by nobody)
    const presented = await withPublicRead((tx) =>
      websiteApi.presentPublicDocs(tx, {
        agencyId: A.agencyId,
        ids: [c1, a1, b1, lone],
        locale: L,
        fallbackLocale: L,
        fallbackName: 'A',
      }),
    );
    expect(membersShown(presented.rows.map((r) => r.targetId))).toEqual([a1]);
    expect([...presented.details.keys()].filter((id) => cluster().has(id))).toEqual([a1]);
    expect(presented.duplicates).toEqual(new Set([c1]));
    // D presents the network members it may: one of them
    const byD = await withPublicRead((tx) =>
      websiteApi.presentPublicDocs(tx, {
        agencyId: D.agencyId,
        ids: [a1, c1],
        locale: L,
        fallbackLocale: L,
        fallbackName: 'D',
      }),
    );
    expect(membersShown(byD.rows.map((r) => r.targetId))).toHaveLength(1);
  }, 60_000);

  it('[R2-03c] listed by N agencies: the cluster mates the caller may see, with each one’s terms; no others named', async () => {
    const forA = await as(A, (ctx) => dedupe.listedBy(ctx, { listingIds: [a1, lone] }));
    expect(forA.items).toHaveLength(1);
    const item = forA.items[0];
    expect(item?.listingId).toBe(a1);
    expect(item?.agencies).toBe(2);
    expect(item?.members.map((m) => m.listingId).sort()).toEqual([a1, c1].sort());
    const own = item?.members.find((m) => m.listingId === a1);
    expect(own).toMatchObject({ own: true, agency: null, commission: null });
    const other = item?.members.find((m) => m.listingId === c1);
    expect(other?.own).toBe(false);
    expect(other?.agency?.id).toBe(C.agencyId);
    expect(other?.commission).toMatchObject({ type: 'PCT', totalBp: 500, splitBp: 5000 });
    expect(other?.price).toMatchObject({ amountCents: 51_000_000, onRequest: false });
    expect(item?.members.filter((m) => m.canonical)).toHaveLength(1);
    // b1 (preferred by nobody) is never named or counted, and asking about it answers nothing
    expect(JSON.stringify(forA)).not.toContain(b1);
    expect((await as(A, (ctx) => dedupe.listedBy(ctx, { listingIds: [b1] }))).items).toEqual([]);
    // B (its owner) sees its own member and the two shared ones
    const forB = await as(B, (ctx) => dedupe.listedBy(ctx, { listingIds: [b1] }));
    expect(forB.items[0]?.agencies).toBe(3);
    expect(forB.items[0]?.members[0]).toMatchObject({ listingId: b1, own: true, canonical: true });
    // within the dashboard budget (mates, cards, the give-to-get gate, terms, names)
    const n = await as(D, (ctx) => countQueries(() => dedupe.listedBy(ctx, { listingIds: [a1, c1, lone] })));
    expect(n).toBeLessThanOrEqual(10);
  }, 60_000);

  it('[R2-03c] feed-api query count and budget: hydration drops other members in the same single statement', async () => {
    const s = NETWORK_WIDE();
    const n = await search.withSiteRead(s, (tx) =>
      countQueries(() => search.publicSiteDocs(tx, s, [...mine], 'card', L, L)),
    );
    expect(n).toBe(1);
    // p95 of the hydration (one page, clustered and plain documents) far within the 150 ms endpoint budget
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await search.withSiteRead(s, (tx) => search.publicSiteDocs(tx, s, [...mine], 'card', L, L));
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95) - 1]).toBeLessThan(50);
  }, 60_000);

  it('[R2-03c] isolation: a public read sees cluster columns only through the site rule; members cannot read them raw', async () => {
    // app_user has no read of the fallback rows at all (noUserRead): the cluster columns there are public paths' only
    const denied = await as(D, async (ctx) => {
      try {
        await ctx.tx.execute(sql`select cluster_id from listing_search_docs where target_id = ${b1}`);
        return false;
      } catch {
        return true;
      }
    });
    expect(denied).toBe(true);
    // a member's read model query shows only the clusters' members its RLS lets it read
    const seen = await as(D, (ctx) => search.visibleClusterMates(ctx.tx, [a1]));
    expect(seen.map((m) => m.targetId)).not.toContain(b1);
  }, 60_000);

  it('[R2-03c] refresh on cluster change: the shown member leaving a site brings its mate into the change feed', async () => {
    const s = NETWORK_WIDE();
    const since = new Date();
    const visibility = async (v: 'PRIVATE' | 'PUBLIC') => {
      const { version } = await as(B, (ctx) => properties.getListing(ctx, b1));
      await as(B, (ctx) => properties.updateListing(ctx, b1, UpdateListingBody.parse({ visibility: v, version })));
      await system((tx) => search.rebuildReadModels(tx, 'LISTING', [b1]));
    };
    await visibility('PRIVATE');
    try {
      const changes = await search.withSiteRead(s, (tx) =>
        search.siteChanges(tx, s, { since, audience: { ownerAgencyId: A.agencyId }, limit: 500 }),
      );
      // b1 left the site; the next in rank order (a1) is now what it shows, and the feed says so
      expect(changes.rows.some((r) => r.targetId === a1 && r.present)).toBe(true);
      expect(changes.rows.filter((r) => r.targetId === b1).every((r) => !r.present)).toBe(true);
      expect(membersShown(await shown(s, downEngine()))).toEqual([a1]);
    } finally {
      await visibility('PUBLIC');
    }
  }, 120_000);

  it('[R2-03c] refresh on cluster change: a member split off loses its cluster everywhere and shows again', async () => {
    const pairsOfC = [a1, b1].map((x) => (x < c1 ? { a: x, b: c1 } : { a: c1, b: x }));
    await system((tx) =>
      repo.upsertDecisions(
        tx,
        pairsOfC.map((p) => ({ ...p, decision: 'NOT_DUPLICATE' as const, source: 'DISPUTE' as const, agencyId: null })),
      ),
    );
    // the rescores above re-scored the pairs from the fixture signatures (no photos: review band): the scorer's pair back
    await pair([a1, A], [b1, B], 0.96, 1_000);
    await dedupe.recluster([c1]);
    const docs = await rows<{ cluster_id: string | null }>(
      sql`select cluster_id from listing_search_docs where target_id = ${c1}`,
    );
    expect(docs[0]?.cluster_id).toBeNull();
    const models = await rows<{ n: number }>(
      sql`select count(*)::int as n from listing_read_models where target_id = ${c1} and cluster_id is not null`,
    );
    expect(models[0]?.n).toBe(0);
    // now its own and every network site show it beside the cluster's member
    expect(membersShown(await shown(NETWORK_WIDE(), ENGINE)).sort()).toEqual([b1, c1].sort());
    expect(membersShown(await shown(NETWORK_D(), downEngine())).sort()).toEqual([a1, c1].sort());
  }, 120_000);
});
