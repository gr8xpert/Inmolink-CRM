import { CreateListingBody, type SavedSearchBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, countQueries, type Tx, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import { listingKeys } from '../alerts';
import * as matching from '../index';
import { matchQuery } from '../repo';

/**
 * Saved searches and alerts (S5-06) on the real test database: the member's own saved searches; a listing's read-model
 * change (`search.listings.changed`) alerts each matching saved search exactly once per change — new, price drop,
 * back on the market — INSTANT ones notified at once, DAILY ones in the digest; the matching query probes the GIN
 * inverse index, never every saved search. The shared DB keeps other suites' saved searches: assertions are scoped to
 * this file's.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** o: owns the listings (and saves a search of its own) · b, b2: a network agency · u: unverified. */
let o: Founder;
let b: Founder;
let b2: Founder;
let u: Founder;
let ids: { country: string; city: string; area: string; elsewhere: string; villa: string; flat: string };
const S: Record<string, string> = {};

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    if (err instanceof ZodError) return 'ZOD';
    throw err;
  }
  return 'accepted';
}

async function agent(agencyId: string, name: string): Promise<Founder> {
  const userId = newId();
  const email = `saved-${name.toLowerCase()}-${userId}@example.com`;
  await system(async (tx) => {
    await tx.execute(sql`insert into users (id, email, password_hash, name, locale, status)
      values (${userId}, ${email}, 'x', ${name}, 'en', 'ACTIVE')`);
    await tx.execute(sql`insert into agency_members (agency_id, user_id, role, name, email)
      values (${agencyId}, ${userId}, 'AGENT', ${name}, ${email})`);
  });
  return { userId, agencyId, email, password: 'x' };
}

const version = async (id: string) => (await as(o, (ctx) => properties.getListing(ctx, id))).version;

async function listing(body: Partial<CreateListingBody> = {}): Promise<string> {
  const { id } = await as(o, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.area,
        priceCents: 50_000_000,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
        ...body,
      }),
    ),
  );
  await as(o, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: await version(id),
      }),
    ),
  );
  return id;
}

const update = async (id: string, change: Partial<UpdateListingBody>) =>
  as(o, async (ctx) =>
    properties.updateListing(ctx, id, UpdateListingBody.parse({ ...change, version: await version(id) })),
  );

/** The read-model rebuild the outbox would queue, then the matching job its event queues. */
async function rebuildAndMatch(id: string) {
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return matching.matchListings({ agencyId: o.agencyId, listingIds: [id] });
}

const save = (f: Founder, body: SavedSearchBody) => as(f, (ctx) => matching.createSavedSearch(ctx, body));

/** This file's saved searches' alerts about `listingId`, by saved search key. */
async function alertsOf(listingId: string): Promise<Record<string, string[]>> {
  const mine = Object.values(S);
  const list = await rows<{ saved_search_id: string; kind: string }>(sql`
    select saved_search_id, kind from saved_search_alerts
     where listing_id = ${listingId} and saved_search_id = any(${`{${mine.join(',')}}`}::uuid[])
     order by kind`);
  const out: Record<string, string[]> = {};
  for (const [k, id] of Object.entries(S)) {
    const kinds = list.filter((r) => r.saved_search_id === id).map((r) => r.kind);
    if (kinds.length > 0) out[k] = kinds;
  }
  return out;
}

const notificationsOf = (f: Founder) =>
  rows<{ params: Record<string, string | number>; link: string }>(sql`
    select params, link from notifications
     where agency_id = ${f.agencyId} and user_id = ${f.userId} and type = 'SAVED_SEARCH_ALERT'
     order by created_at, id`);

beforeAll(async () => {
  await setupTestDb('worker');
  [o, b, u] = await Promise.all([createFounder(), createFounder(), createFounder()]);
  for (const f of [o, b]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  b2 = await agent(b.agencyId, 'Bea');
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: 'en', name: `${x} ${RUN}`, slug: `ss-${x.toLowerCase()}-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ss-${RUN}`,
      translations: name('Savedland'),
    });
    const elsewhere = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ss-x-${RUN}`,
      translations: name('Otherland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `ss-r-${RUN}`,
      translations: name('Savedregion'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `ss-c-${RUN}`,
      translations: name('Savedcity'),
    });
    const area = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: city,
      code: `ss-a-${RUN}`,
      translations: name('Savedarea'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `ss-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const type = (t: string) =>
      taxonomy.createPropertyType(tx, { groupId: group, key: `ss-${t}-${RUN}`, sort: 0, translations: name(t) });
    return { country, city, area, elsewhere, villa: await type('Villa'), flat: await type('Flat') };
  });
  const villas = { propertyTypeIds: [ids.villa], locationIds: [ids.city], priceMaxCents: 60_000_000 };
  S.villas = (await save(b, { name: 'Villas in the city', ...villas })).id;
  S.daily = (
    await save(b, { name: 'Daily sales', transactionType: 'SALE', locationIds: [ids.country], frequency: 'DAILY' })
  ).id;
  S.flats = (await save(b2, { name: 'Flats', propertyTypeIds: [ids.flat], locationIds: [ids.country] })).id;
  S.off = (await save(b, { name: 'Off', ...villas, frequency: 'OFF' })).id;
  S.ownOnly = (await save(b, { name: 'Own stock only', ...villas, scope: 'OWN' })).id;
  S.cheap = (await save(b2, { name: 'Cheap', ...villas, priceMaxCents: 10_000_000 })).id;
  S.elsewhere = (await save(b2, { name: 'Elsewhere', locationIds: [ids.elsewhere] })).id;
  S.newOnly = (await save(b2, { name: 'New only', ...villas, alerts: ['NEW'] })).id;
  S.owner = (await save(o, { name: 'Our villas', ...villas })).id;
  S.unverified = (await save(u, { name: 'Unverified', ...villas })).id;
}, 240_000);

afterAll(async () => {
  await closeDb();
});

describe('saved searches', () => {
  it('[S5-06] a member lists, changes and deletes their own saved searches; colleagues cannot', async () => {
    const created = await save(b2, { name: `Temp ${RUN}`, locationIds: [ids.area], bedsMin: 3, areaMinM2: 80.5 });
    expect(created).toMatchObject({
      scope: 'ALL',
      frequency: 'INSTANT',
      alerts: ['NEW', 'PRICE_DROP', 'BACK_ON_MARKET'],
      bedsMin: 3,
      areaMinM2: 80.5,
      transactionType: null,
    });
    const listed = await as(b2, (ctx) => matching.listSavedSearches(ctx));
    expect(listed.items.map((s) => s.id)).toContain(created.id);
    // a colleague neither sees nor changes it
    expect((await as(b, (ctx) => matching.listSavedSearches(ctx))).items.map((s) => s.id)).not.toContain(created.id);
    expect(await refusal(as(b, (ctx) => matching.deleteSavedSearch(ctx, created.id)))).toBe('SAVED_SEARCH_NOT_FOUND');
    expect(await refusal(as(b, (ctx) => matching.updateSavedSearch(ctx, created.id, { name: 'Mine now' })))).toBe(
      'SAVED_SEARCH_NOT_FOUND',
    );
    const changed = await as(b2, (ctx) =>
      matching.updateSavedSearch(ctx, created.id, { name: 'Renamed', frequency: 'DAILY', alerts: ['PRICE_DROP'] }),
    );
    expect(changed).toMatchObject({ name: 'Renamed', frequency: 'DAILY', alerts: ['PRICE_DROP'], locationIds: [] });
    await as(b2, (ctx) => matching.deleteSavedSearch(ctx, created.id));
    expect((await as(b2, (ctx) => matching.listSavedSearches(ctx))).items.map((s) => s.id)).not.toContain(created.id);
  });

  it('[S5-06] invalid criteria and unknown locations are refused', async () => {
    expect(await refusal(save(b2, { name: 'x', priceMinCents: 2, priceMaxCents: 1 }))).toBe('ZOD');
    expect(await refusal(save(b2, { name: '' }))).toBe('ZOD');
    expect(await refusal(save(b2, { name: 'x', locationIds: [newId()] }))).toBe('VALIDATION_FAILED');
  });

  it('[S5-06] at most 50 saved searches per member', async () => {
    const f = await createFounder();
    await system((tx) =>
      tx.execute(sql`insert into saved_searches (id, agency_id, user_id, name, match_keys)
        select gen_random_uuid(), ${f.agencyId}, ${f.userId}, 'Filler ' || g, array['*:*']
          from generate_series(1, 50) g`),
    );
    expect(await refusal(save(f, { name: 'One too many' }))).toBe('SAVED_SEARCH_LIMIT');
  });
});

describe('saved search alerts', () => {
  let L1: string;

  it('[S5-06] a read-model change of a listing emits search.listings.changed for it', async () => {
    L1 = await listing();
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [L1]));
    const events = await rows<{ payload: { listingIds: string[] } }>(sql`
      select payload from outbox_events where type = 'search.listings.changed' and agency_id = ${o.agencyId}`);
    expect(events.some((e) => e.payload.listingIds.includes(L1))).toBe(true);
  });

  it('[S5-06] a new matching listing produces exactly one alert per saved search (deduplicated)', async () => {
    const first = await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    expect(first.transitions).toBe(1);
    // redelivered event, retried job, a second rebuild of the same state: nothing more
    await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    await rebuildAndMatch(L1);
    expect(await alertsOf(L1)).toEqual({
      villas: ['NEW'],
      daily: ['NEW'],
      newOnly: ['NEW'],
      owner: ['NEW'],
    });
    // INSTANT searches are notified once, with a link to the saved searches; DAILY waits for the digest
    const bea = await notificationsOf(b2);
    expect(bea).toHaveLength(1);
    expect(bea[0]).toMatchObject({
      link: '/network/saved-searches',
      params: { kind: 'NEW', count: 1, subject: 'New only' },
    });
    expect((await notificationsOf(b)).map((n) => n.params.subject)).toEqual(['Villas in the city']);
    expect(await notificationsOf(u)).toHaveLength(0);
  });

  it('[S5-06] two jobs for the same new listing at once still alert each saved search once', async () => {
    const L2 = await listing({ priceCents: 45_000_000 });
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', [L2]));
    await Promise.all([
      matching.matchListings({ agencyId: o.agencyId, listingIds: [L2] }),
      matching.matchListings({ agencyId: o.agencyId, listingIds: [L2] }),
    ]);
    expect(await alertsOf(L2)).toEqual({ villas: ['NEW'], daily: ['NEW'], newOnly: ['NEW'], owner: ['NEW'] });
  });

  it('[S5-06] a price drop alerts once per saved search; a price rise alerts nobody', async () => {
    await update(L1, { priceCents: 55_000_000 });
    expect((await rebuildAndMatch(L1)).transitions).toBe(0);
    await update(L1, { priceCents: 42_000_000 });
    expect((await rebuildAndMatch(L1)).transitions).toBe(1);
    await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    const alerts = await alertsOf(L1);
    expect(alerts).toEqual({
      villas: ['NEW', 'PRICE_DROP'],
      daily: ['NEW', 'PRICE_DROP'],
      newOnly: ['NEW'],
      owner: ['NEW', 'PRICE_DROP'],
    });
    const [drop] = await rows<{ price_cents: string; previous_price_cents: string }>(sql`
      select price_cents, previous_price_cents from saved_search_alerts
       where listing_id = ${L1} and saved_search_id = ${S.villas} and kind = 'PRICE_DROP'`);
    expect([Number(drop?.price_cents), Number(drop?.previous_price_cents)]).toEqual([42_000_000, 55_000_000]);
  });

  it('[S5-06] a listing back on the market alerts once per saved search', async () => {
    await update(L1, { status: 'UNDER_OFFER' });
    expect((await rebuildAndMatch(L1)).transitions).toBe(0);
    await update(L1, { status: 'ACTIVE' });
    expect((await rebuildAndMatch(L1)).transitions).toBe(1);
    await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    expect((await alertsOf(L1)).villas).toEqual(['BACK_ON_MARKET', 'NEW', 'PRICE_DROP']);
  });

  it('[S5-06] the daily digest notifies each DAILY saved search once with what it matched', async () => {
    const before = (await notificationsOf(b)).length;
    let sent = await matching.sendDigest(b.agencyId);
    while (sent.more) sent = await matching.sendDigest(b.agencyId);
    const after = await notificationsOf(b);
    const digest = after.slice(before).find((n) => n.params.subject === 'Daily sales');
    // L1 (new, price drop, back on market) and L2 (new)
    expect(digest?.params).toMatchObject({ kind: 'DIGEST', count: 4 });
    expect(await matching.sendDigest(b.agencyId)).toMatchObject({ notified: 0 });
    const pending = await rows<{ n: number }>(sql`
      select count(*)::int as n from saved_search_alerts where saved_search_id = ${S.daily} and notified_at is null`);
    expect(pending[0]?.n).toBe(0);
  });

  it('[S5-06] matching a batch of listings costs a bounded number of statements', async () => {
    const batch = [
      await listing(),
      await listing({ priceCents: 30_000_000 }),
      await listing({ propertyTypeId: ids.flat }),
    ];
    await system((tx) => search.rebuildReadModels(tx, 'LISTING', batch));
    const n = await countQueries(() => matching.matchListings({ agencyId: o.agencyId, listingIds: batch }));
    expect(n).toBeLessThanOrEqual(16);
    expect(Object.keys(await alertsOf(batch[2] as string)).sort()).toEqual(['daily', 'flats']);
  });

  it('[S5-06] the matching query probes the GIN inverse index, never every saved search (EXPLAIN, 60k searches)', async () => {
    const probes = [
      {
        listingId: newId(),
        ownerAgencyId: o.agencyId,
        kind: 'NEW' as const,
        keys: listingKeys({ transactionType: 'SALE', locationIds: [ids.country, ids.city, ids.area] }),
        propertyTypeId: ids.villa,
        featureIds: [],
        priceCents: 50_000_000,
        beds: 3,
        baths: 2,
        areaM2: 120,
        network: true,
        shareAll: true,
        preferredAgencyIds: [],
      },
    ];
    const plan = await withAdminRollback(['saved_searches'], async (q) => {
      await q('set local session_replication_role = replica');
      // 60k saved searches of other places (a realistic spread: 2,000 places × 30), plus a few broad ones
      await q(
        `insert into saved_searches (id, agency_id, user_id, name, match_keys)
         select gen_random_uuid(), $1, gen_random_uuid(), 'Bulk ' || g,
                array[(case when g % 3 = 0 then 'SALE' else 'RENT_LONG_TERM' end) || ':' || md5((g % 2000)::text)]
           from generate_series(1, 60000) g`,
        [b.agencyId],
      );
      await q(
        `insert into saved_searches (id, agency_id, user_id, name, match_keys)
         select gen_random_uuid(), $1, gen_random_uuid(), 'Broad ' || g, array['*:*'] from generate_series(1, 20) g`,
        [b.agencyId],
      );
      await q('analyze saved_searches');
      // what (auto)vacuum does in production: the fresh rows leave GIN's pending list for the index proper
      await q(`select gin_clean_pending_list('saved_searches_match_keys_idx'::regclass)`);
      await q('set local role app_system');
      const query = new PgDialect().sqlToQuery(matchQuery(probes));
      const out = await q(`explain (analyze, format json) ${query.sql}`, query.params);
      return Object.values(out[0] ?? {})[0];
    });
    const nodes: Record<string, unknown>[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push(n);
      for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk((plan as { Plan: Record<string, unknown> }[])[0]?.Plan as Record<string, unknown>);
    const onSearches = nodes.filter((n) => n['Relation Name'] === 'saved_searches' || n['Index Name']);
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'saved_searches')).toBe(false);
    const index = nodes.find((n) => n['Node Type'] === 'Bitmap Index Scan');
    expect(index?.['Index Name']).toBe('saved_searches_match_keys_idx');
    // the candidates read: this file's and the broad ones, never the 60k of other places
    const heap = nodes.find((n) => n['Node Type'] === 'Bitmap Heap Scan');
    expect(Number(heap?.['Actual Rows'] ?? 0) * Number(heap?.['Actual Loops'] ?? 1)).toBeLessThan(2_000);
    expect(onSearches.length).toBeGreaterThan(0);
    // the hot-path SQL budget (< 20 ms p95)
    expect((plan as { 'Execution Time': number }[])[0]?.['Execution Time']).toBeLessThan(20);
    console.info(
      `[S5-06] matching plan: ${nodes.map((n) => `${n['Node Type']}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`).join(' → ')}, ` +
        `${heap?.['Actual Rows']} candidates, ${(plan as { 'Execution Time': number }[])[0]?.['Execution Time']} ms`,
    );
  }, 120_000);
});
