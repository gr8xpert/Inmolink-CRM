import {
  CreateListingBody,
  type CreateSiteInput,
  UpdateListingBody,
  WebsiteChangesPage,
  WebsiteChangesQuery,
  WebsiteDetail,
  WebsiteListingPage,
  WebsiteListingsQuery,
  WebsiteSitemapPage,
  WebsiteSitemapQuery,
} from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem } from '@inmolink/db';
import { adminQuery, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import * as websiteApi from '../index';

/**
 * Website API v2 reads (S7-03): the site's inventory, white-labelled, within the query budget; the delta feed returns
 * every change exactly once across pages, also when writers commit out of order; give-to-get applies to websites.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const UID = `t_wapi_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });

/** a: the site's agency (shares a listing: give-to-get open) · b: network owner · e: shares nothing (locked). */
let a: Founder;
let b: Founder;
let e: Founder;
let ids: { country: string; city: string; villa: string };
const L: Record<string, string> = {};
const S: Record<string, string> = {};

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.test', fn);

async function listing(
  m: Founder,
  body: Partial<CreateListingBody>,
  state: Pick<UpdateListingBody, 'visibility' | 'shareScope'>,
): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
        ...body,
      }),
    ),
  );
  await update(m, id, { status: 'ACTIVE', ...state });
  return id;
}

/** Edits a listing and rebuilds its read models (the worker's job). */
async function update(m: Founder, id: string, patch: Partial<UpdateListingBody>): Promise<void> {
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({ ...patch, version: (await properties.getListing(ctx, id)).version }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
}

const SITE: CreateSiteInput = {
  name: 'Costa Homes',
  domains: ['www.costa-homes.example'],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_PLUS_NETWORK',
  inventoryFilters: null,
  referencePrefix: 'CH',
  locales: ['en', 'es'],
  contact: null,
};

const keyOf = (m: Founder, siteId: string) => ({ agencyId: m.agencyId, siteId });
const site = (m: Founder, siteId: string) => websiteApi.siteForKey(keyOf(m, siteId), newId());
const refOf = async (id: string) =>
  (await system((tx) => tx.execute<{ ref: string }>(sql`select ref from properties where id = ${id}`))).rows[0]
    ?.ref as string;
const codeOf = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;
const listings = (q: Partial<WebsiteListingsQuery> = {}) =>
  WebsiteListingsQuery.parse({ locations: ids.country, ...q }) as WebsiteListingsQuery;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: `t:wapi:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  search.configureWebsiteSearch({ engineTimeoutMs: 5_000, slowMs: 4_000 });
  // Give-to-get: one listing shared with the whole network, no grace period.
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  websites.configureSiteFeeds({ tokenKey: 'test-hmac-key-0123456789abcdef0123456789' });
  configureStorage(createMemoryStore());
  [a, b, e] = [await createFounder(), await createFounder(), await createFounder()];
  for (const m of [a, b, e]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('wa'),
      translations: name('Apiland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('wa-r'),
      translations: name('Shore'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('wa-c'),
      translations: name('Gamma'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('wa-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('wa-villa'),
      sort: 0,
      translations: name('Villa'),
    });
    return { country, city, villa };
  });
  L.aVilla = await listing(a, {}, { visibility: 'PUBLIC', shareScope: 'ALL' });
  L.aFlat = await listing(a, { priceCents: 20_000_000 }, { visibility: 'PUBLIC', shareScope: 'ALL' });
  L.bAll = await listing(b, { priceCents: 40_000_000 }, { visibility: 'PUBLIC', shareScope: 'ALL' });
  L.bOther = await listing(b, { priceCents: 41_000_000 }, { visibility: 'PUBLIC', shareScope: 'ALL' });
  L.eOwn = await listing(e, { priceCents: 50_000_000 }, { visibility: 'PUBLIC', shareScope: 'PREFERRED' });
  S.a = (await as(a, (ctx) => websites.createSite(ctx, SITE))).id;
  S.aOwn = (await as(a, (ctx) => websites.createSite(ctx, { ...SITE, name: 'Own', inventoryPolicy: 'OWN_ONLY' }))).id;
  S.aCustom = (
    await as(a, (ctx) =>
      websites.createSite(ctx, {
        ...SITE,
        name: 'Apiland',
        inventoryPolicy: 'CUSTOM',
        inventoryFilters: {
          includeOwn: true,
          includeNetwork: true,
          locationIds: [ids.country],
          propertyTypeIds: [],
          newBuilds: true,
        },
      }),
    )
  ).id;
  S.e = (await as(e, (ctx) => websites.createSite(ctx, { ...SITE, name: 'Locked' }))).id;

  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: Object.values(L) });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  search.resetSearchBreaker();
}, 180_000);

afterEach(() => restoreClock());

afterAll(async () => {
  await real()
    .dropIndex(UID)
    .catch(() => undefined);
  if (Object.keys(L).length > 0) {
    const all = sql.join(
      Object.values(L).map((t) => sql`${t}`),
      sql`, `,
    );
    await system(async (tx) => {
      await tx.execute(sql`delete from search_index_queue where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_docs where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_commissions where target_id in (${all})`);
    });
  }
  await closeCache();
  await closeDb();
});

describe('website API v2 reads (S7-03)', () => {
  it('[S7-03] keys created before sites existed are refused; a site serves its own agency only', async () => {
    expect(await refusal(websiteApi.siteForKey({ agencyId: a.agencyId, siteId: null }, newId()))).toBe(
      'API_KEY_SITE_REQUIRED',
    );
    expect(await refusal(websiteApi.siteForKey({ agencyId: b.agencyId, siteId: S.a as string }, newId()))).toBe(
      'SITE_NOT_FOUND',
    );
    const s = await site(a, S.a as string);
    expect(await refusal(websiteApi.searchListings(s, listings({ lang: 'de' })))).toBe('VALIDATION_FAILED');
  });

  it('[S7-03] search, detail and sitemap serve the site inventory white-labelled (codes, scoped ids)', async () => {
    const s = await site(a, S.a as string);
    const page = WebsiteListingPage.parse(await websiteApi.searchListings(s, listings({ sort: 'price_asc' })));
    const [bCode, bRef, aRef] = [
      await codeOf(L.bAll as string),
      await refOf(L.bAll as string),
      await refOf(L.aVilla as string),
    ];
    expect(page.items.map((i) => i.ref)).toEqual([
      await refOf(L.aFlat as string),
      aRef,
      `CH-${bCode}`,
      `CH-${await codeOf(L.bOther as string)}`,
    ]);
    // Own listings keep their ids; network ones show an id scoped to the site's agency.
    expect(page.items[1]?.id).toBe(L.aVilla);
    expect(page.items[2]?.id).toBe(websites.siteScopedId(a.agencyId, L.bAll as string));
    const json = JSON.stringify(page);
    for (const leak of [L.bAll, L.bOther, bRef, b.agencyId, L.eOwn])
      expect(json.includes(leak as string), leak).toBe(false);

    // Detail: own reference, the network listing's site code; the owner's own reference finds nothing here.
    const own = WebsiteDetail.parse(await websiteApi.listingDetail(s, aRef, 'es'));
    expect(own).toMatchObject({ id: L.aVilla, ref: aRef });
    const network = WebsiteDetail.parse(await websiteApi.listingDetail(s, `ch-${bCode.toLowerCase()}`));
    expect(network.ref).toBe(`CH-${bCode}`);
    expect(JSON.stringify(network).includes(bRef)).toBe(false);
    expect(await refusal(websiteApi.listingDetail(s, bRef))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(websiteApi.listingDetail(s, bCode))).toBe('LISTING_NOT_FOUND');
    // Another agency's own-only site does not show it at all.
    const own2 = await site(a, S.aOwn as string);
    expect(await refusal(websiteApi.listingDetail(own2, `CH-${bCode}`))).toBe('LISTING_NOT_FOUND');

    // Sitemap (CUSTOM: this run's country): every listing once over pages of one, refs as the site shows them.
    const custom = await site(a, S.aCustom as string);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = WebsiteSitemapPage.parse(
        await websiteApi.sitemap(custom, WebsiteSitemapQuery.parse({ limit: 1, ...(cursor ? { cursor } : {}) })),
      );
      seen.push(...p.items.map((i) => i.ref));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual([...page.items.map((i) => i.ref)].sort());
  });

  it('[S7-03] a website of an agency locked by give-to-get shows only its own listings', async () => {
    const locked = await site(e, S.e as string);
    expect(locked.inventory?.networkOf).toBeUndefined();
    const page = await websiteApi.searchListings(locked, listings());
    expect(page.items.map((i) => i.id)).toEqual([L.eOwn]);
    expect(await refusal(websiteApi.listingDetail(locked, `CH-${await codeOf(L.bAll as string)}`))).toBe(
      'LISTING_NOT_FOUND',
    );
    // Agency a shares a listing with the whole network: its site shows the network.
    expect((await site(a, S.a as string)).inventory?.networkOf).toBe(a.agencyId);
  });

  it('[S7-03] each endpoint answers within 3 queries, with or without compiled owner identities', async () => {
    const s = await site(a, S.a as string);
    const custom = await site(a, S.aCustom as string);
    const bCode = await codeOf(L.bAll as string);
    // Changes of this run's listings exist (written in the last hour): pages of one always hold a row.
    const changesQ = WebsiteChangesQuery.parse({ since: new Date(Date.now() - 3_600_000).toISOString(), limit: 1 });
    const first = await websiteApi.changes(s, changesQ);
    expect(first.items).toHaveLength(1);
    // Warm the caches once (owner identities are compiled per process).
    await websiteApi.searchListings(s, listings());
    const budget: Record<string, number> = {
      search: await countQueries(() => websiteApi.searchListings(s, listings())),
      detail: await countQueries(() => websiteApi.listingDetail(s, `CH-${bCode}`)),
      // `since` finds its starting position first; a cursor does not.
      changesSince: await countQueries(() => websiteApi.changes(s, changesQ)),
      changes: await countQueries(() =>
        websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: first.nextCursor, limit: 1 })),
      ),
      sitemap: await countQueries(() => websiteApi.sitemap(custom, WebsiteSitemapQuery.parse({ limit: 10 }))),
      siteForKey: await countQueries(() => site(a, S.a as string)),
    };
    expect(budget).toEqual({ search: 2, detail: 2, changesSince: 3, changes: 2, sitemap: 2, siteForKey: 0 });
    // Owner identities are read with the overrides, compiled or not: the same statements cold.
    websiteApi.resetWebsiteApiCaches();
    expect(await countQueries(() => websiteApi.searchListings(s, listings()))).toBe(2);
    websiteApi.resetWebsiteApiCaches();
    expect(await countQueries(() => websiteApi.listingDetail(s, `CH-${bCode}`))).toBe(2);
    // A site whose scope is not cached yet: its row and presenter (two statements, then cached for a minute).
    const fresh = (await as(a, (ctx) => websites.createSite(ctx, { ...SITE, name: 'Cold' }))).id;
    expect(await countQueries(() => site(a, fresh))).toBe(2);
  });
});

describe('per-site XML feed reads (S8-F1)', () => {
  it('[S8-F1] the feed route (/v2/feeds/:token/:file) stays within 3 queries, warm and cold', async () => {
    const token = (await as(a, (ctx) => websites.rotateSiteFeed(ctx, { siteId: S.a as string }))).secret.token;
    expect(await websiteApi.generateSiteFeed(S.a as string)).toMatchObject({ runId: expect.any(String) });
    // Cold: the site's scope in no cache — the token lookup, then the site row and its presenter.
    await cache.delete(websites.siteCacheKey(S.a as string));
    cache.clearLocal();
    expect(await countQueries(() => websiteApi.siteFeedFile(token, 'kyero.xml'))).toBeLessThanOrEqual(3);
    // Warm: the token lookup alone.
    expect(await countQueries(() => websiteApi.siteFeedFile(token, 'inmolink.xml'))).toBe(1);
    await as(a, (ctx) => websites.revokeSiteFeed(ctx, { siteId: S.a as string }));
  });
});

// Waits for the horizon (`settled`, up to a minute) may follow other files' long transactions.
describe('website delta feed (S7-03)', { timeout: 120_000 }, () => {
  /** Pages a site's feed from `since` (or a cursor) until nothing more is ready. */
  async function drain(siteId: string, from: Date | string, limit: number) {
    const s = await site(a, siteId);
    const items: WebsiteChangesPage['items'] = [];
    const first = typeof from === 'string' ? { cursor: from, limit } : { since: from.toISOString(), limit };
    let page = WebsiteChangesPage.parse(await websiteApi.changes(s, WebsiteChangesQuery.parse(first)));
    items.push(...page.items);
    while (page.hasMore) {
      page = WebsiteChangesPage.parse(
        await websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: page.nextCursor, limit })),
      );
      items.push(...page.items);
    }
    return { items, cursor: page.nextCursor, scope: page.scope };
  }

  /** The database's clock (`changed_at` is written by it). */
  const dbNow = async () =>
    new Date(
      (await system((tx) => tx.execute<{ now: string }>(sql`select now()::text as now`))).rows[0]?.now as string,
    );

  /**
   * Waits until the feed's horizon has passed every transaction this test has committed (S7-03 flake fix). Pages are
   * commit-safe below the snapshot's `xmin`, which is cluster-wide: a transaction another test file (or anything
   * else on the server) has open holds every feed back, and the feed then rightly answers "nothing yet". No database
   * or schema isolates that, so the test waits — bounded — for transactions older than a marker transaction it
   * commits now, exactly as a client polls again. A timeout names the transactions that held the horizon.
   */
  async function settled(timeoutMs = 60_000): Promise<void> {
    const mark = (await system((tx) => tx.execute<{ x: string }>(sql`select pg_current_xact_id()::text as x`))).rows[0]
      ?.x as string;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { ok, xmin } = (
        await withPublicRead((tx) =>
          tx.execute<{ ok: boolean; xmin: string }>(
            sql`select pg_snapshot_xmin(pg_current_snapshot()) > ${mark}::xid8 as ok,
                       pg_snapshot_xmin(pg_current_snapshot())::text as xmin`,
          ),
        )
      ).rows[0] as { ok: boolean; xmin: string };
      if (ok) return;
      if (Date.now() > deadline) {
        const open = await adminQuery(
          `select pid, backend_xid::text as xid, application_name as app, state, now() - xact_start as age
             from pg_stat_activity where backend_xid is not null and backend_xid::text::bigint <= $1::bigint`,
          [mark],
        );
        throw new Error(
          `change-log horizon ${xmin} still below ${mark} after ${timeoutMs} ms: ${JSON.stringify(open)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The change log's rows for agency a since `since`, in commit-safe order. */
  const logged = async (since: Date) =>
    (
      await system((tx) =>
        tx.execute<{ target_id: string }>(
          sql`select target_id from listing_public_changes
               where owner_agency_id = ${a.agencyId} and changed_at >= ${since.toISOString()}::timestamptz
               order by tx_id, seq`,
        ),
      )
    ).rows.map((r) => r.target_id);

  it('[S7-03] /v2/changes returns every change exactly once across pages', async () => {
    // Caught up first (`since` may start a few minutes early); every change after this cursor is checked exactly.
    // Caught up to a settled horizon: the setup's own changes are below it, so none of them lands after `start`.
    await settled();
    const { cursor: start } = await drain(S.aOwn as string, await dbNow(), 1_000);
    const since = await dbNow();
    const [villa, flat] = [L.aVilla as string, L.aFlat as string];
    for (const price of [31_000_000, 32_000_000, 33_000_000]) await update(a, villa, { priceCents: price });
    await update(a, flat, { visibility: 'SHARED' });
    const fresh = await listing(a, { priceCents: 25_000_000 }, { visibility: 'PUBLIC', shareScope: 'ALL' });
    L.aFresh = fresh;
    await settled();
    const log = await logged(since);
    expect(log.length).toBeGreaterThanOrEqual(5);
    // Pages of two: every logged change once, in the log's order.
    const { items, cursor } = await drain(S.aOwn as string, start, 2);
    const refs = new Map([
      [villa, await refOf(villa)],
      [flat, await refOf(flat)],
      [fresh, await refOf(fresh)],
    ]);
    expect(items.map((i) => i.ref)).toEqual(log.map((id) => refs.get(id)));
    // The flat left the public site: REMOVE; the villa and the new listing: UPSERT.
    expect(items.filter((i) => i.ref === refs.get(flat)).at(-1)?.change).toBe('REMOVE');
    expect(items.filter((i) => i.ref === refs.get(villa)).every((i) => i.change === 'UPSERT')).toBe(true);
    // Nothing new: the cursor stays where it is.
    const again = await websiteApi.changes(await site(a, S.aOwn as string), WebsiteChangesQuery.parse({ cursor }));
    expect(again.items).toEqual([]);
    await update(a, flat, { visibility: 'PUBLIC' });
  });

  it('[S7-03] a change committed after a later one is still returned once, in order (out-of-order commits)', async () => {
    const s = await site(a, S.aOwn as string);
    // From a settled horizon: `since` with nothing newer starts at the horizon, which must be past the earlier tests.
    await settled();
    const start = await websiteApi.changes(s, WebsiteChangesQuery.parse({ since: (await dbNow()).toISOString() }));
    const row = (target: string) =>
      sql`insert into listing_public_changes (target_id, kind, owner_agency_id, ref, shared_all)
          values (${target}, 'LISTING', ${a.agencyId}, ${`REF-${target.slice(-4)}`}, true)`;
    const [first, second] = [newId(), newId()];
    // T1 writes first (smaller transaction id) and stays open; T2 writes and commits.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const t1 = system(async (tx) => {
      await tx.execute(row(first));
      wrote();
      await held;
    });
    await written;
    await system((tx) => tx.execute(row(second)));
    // T2 has committed, but T1 is still open: neither is handed out yet (T2 would pass T1's position).
    const during = await websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: start.nextCursor }));
    expect(during.items).toEqual([]);
    release();
    await t1;
    // Committed: the next page holds both once the horizon passes them (another test file may hold it a moment).
    await settled();
    const after = await websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: during.nextCursor }));
    expect(after.items.map((i) => i.ref)).toEqual([`REF-${first.slice(-4)}`, `REF-${second.slice(-4)}`]);
    expect(after.items.every((i) => i.change === 'REMOVE')).toBe(true);
    const done = await websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: after.nextCursor }));
    expect(done.items).toEqual([]);
  });

  it('[S7-03] `since` finds a change whose transaction started later but took its id earlier', async () => {
    const s = await site(a, S.aOwn as string);
    const since = await dbNow();
    const row = (target: string) =>
      sql`insert into listing_public_changes (target_id, kind, owner_agency_id, ref, shared_all)
          values (${target}, 'LISTING', ${a.agencyId}, ${`SNC-${target.slice(-4)}`}, true)`;
    const [early, late] = [newId(), newId()];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    // `early` starts first (its `changed_at` is the earliest since `since`) but writes last (a larger id).
    const slow = system(async (tx) => {
      await tx.execute(sql`select 1`);
      started();
      await held;
      await tx.execute(row(early));
    });
    await begun;
    await system((tx) => tx.execute(row(late)));
    release();
    await slow;
    await settled();
    const page = await websiteApi.changes(s, WebsiteChangesQuery.parse({ since: since.toISOString(), limit: 1_000 }));
    const refs = page.items.map((i) => i.ref);
    expect(refs).toContain(`SNC-${late.slice(-4)}`);
    expect(refs.indexOf(`SNC-${late.slice(-4)}`)).toBeLessThan(refs.indexOf(`SNC-${early.slice(-4)}`));
  });

  it("[S7-03] a network site's feed holds only changes it could show: its own and those shared with it", async () => {
    const since = await dbNow();
    await update(b, L.bOther as string, { priceCents: 41_500_000 });
    await update(e, L.eOwn as string, { priceCents: 50_500_000 });
    await settled();
    const s = await site(a, S.a as string);
    const page = await websiteApi.changes(s, WebsiteChangesQuery.parse({ since: since.toISOString(), limit: 1_000 }));
    const shown = page.items.map((i) => i.ref);
    const bCode = `CH-${await codeOf(L.bOther as string)}`;
    expect(page.items.find((i) => i.ref === bCode)?.change).toBe('UPSERT');
    // e prefers no one: its listing could never be on a's site, so its activity is not in the feed at all.
    expect(shown).not.toContain(`CH-${await codeOf(L.eOwn as string)}`);
    // A forged cursor (another position or age) is refused.
    const c = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...c, h: (c.h as number) + 24 * 60 })).toString('base64url');
    expect(await refusal(websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: forged })))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('[S7-03] a cursor older than the change log keeps answers CHANGES_EXPIRED', async () => {
    const s = await site(a, S.aOwn as string);
    const page = await websiteApi.changes(s, WebsiteChangesQuery.parse({ since: new Date().toISOString() }));
    useFakeClock(new Date(Date.now() + (search.PUBLIC_CHANGES_RETENTION_DAYS + 1) * 86_400_000));
    expect(await refusal(websiteApi.changes(s, WebsiteChangesQuery.parse({ cursor: page.nextCursor })))).toBe(
      'CHANGES_EXPIRED',
    );
    restoreClock();
    const old = new Date(Date.now() - (search.PUBLIC_CHANGES_RETENTION_DAYS + 1) * 86_400_000);
    expect(await refusal(websiteApi.changes(s, WebsiteChangesQuery.parse({ since: old.toISOString() })))).toBe(
      'CHANGES_EXPIRED',
    );
  });
});
