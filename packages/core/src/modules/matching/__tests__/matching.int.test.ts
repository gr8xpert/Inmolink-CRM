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
import { listingKeys, searchKeys } from '../alerts';
import * as matching from '../index';
import { type ListingProbe, matchCandidates, matchQuery } from '../repo';

/**
 * Saved searches and alerts (S5-06) on the real test database: the member's own saved searches; a listing's read-model
 * change (`search.listings.changed`) alerts each matching saved search exactly once per change — new, price drop,
 * back on the market — sent within a short window (INSTANT) or daily, re-checked when sent; other agencies' searches
 * only while they take part in the network (verified, give-to-get open) and the owner is listed; the matching query
 * probes the GIN inverse index with keys that carry who may see the listing. The shared DB keeps other suites' saved
 * searches: assertions are scoped to this file's.
 */

const RUN = newId().slice(-8).toLowerCase();
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/**
 * o: owns the listings (and saves a search of its own) · o2: another owner, suspended later · b, b2: a network agency
 * (within its give-to-get grace) · u: unverified, with a network search from before (stale keys) · g: verified, its
 * grace ends after it saved a search · k: verified, give-to-get LOCKED from the start.
 */
let o: Founder;
let o2: Founder;
let b: Founder;
let b2: Founder;
let u: Founder;
let g: Founder;
let k: Founder;
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

/** Moves the agency's sign-up 60 days back: past give-to-get's grace, so LOCKED while it shares nothing. */
const pastGrace = (f: Founder) =>
  rows(sql`update agencies set created_at = now() - interval '60 days' where agency_id = ${f.agencyId}`);

const version = async (f: Founder, id: string) => (await as(f, (ctx) => properties.getListing(ctx, id))).version;

async function listing(body: Partial<CreateListingBody> = {}, f: Founder = o): Promise<string> {
  const { id } = await as(f, (ctx) =>
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
  await as(f, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: await version(f, id),
      }),
    ),
  );
  return id;
}

const update = async (id: string, change: Partial<UpdateListingBody>, f: Founder = o) =>
  as(f, async (ctx) =>
    properties.updateListing(ctx, id, UpdateListingBody.parse({ ...change, version: await version(f, id) })),
  );

const rebuild = (ids: string[]) => system((tx) => search.rebuildReadModels(tx, 'LISTING', ids));

/** The read-model rebuild the outbox would queue, then the matching job its event queues. */
async function rebuildAndMatch(id: string, f: Founder = o) {
  await rebuild([id]);
  return matching.matchListings({ agencyId: f.agencyId, listingIds: [id] });
}

/** The short digest of every agency of this file (what `matching.sendAlerts` INSTANT does after its window). */
async function sendInstant() {
  for (const f of [o, o2, b, u, g, k]) {
    for (let r = await matching.sendAlerts(f.agencyId, 'INSTANT'); r.more; ) {
      r = await matching.sendAlerts(f.agencyId, 'INSTANT');
    }
  }
}

const save = (f: Founder, body: SavedSearchBody) => as(f, (ctx) => matching.createSavedSearch(ctx, body));

/** A saved search written as it was before the review's keys (no gate check, `net:` keys): stale keys. */
async function staleNetworkSearch(f: Founder, name: string): Promise<string> {
  const id = newId();
  const keys = searchKeys({ agencyId: f.agencyId, scope: 'ALL', transactionType: null, locationIds: [ids.city] }, true);
  await rows(sql`insert into saved_searches (id, agency_id, user_id, name, property_type_ids, location_ids,
                   price_max_cents, match_keys)
    values (${id}, ${f.agencyId}, ${f.userId}, ${name}, ${`{${ids.villa}}`}::uuid[], ${`{${ids.city}}`}::uuid[],
            60000000, ${`{${keys.join(',')}}`}::text[])`);
  return id;
}

/** This file's saved searches' alerts about `listingId`, by saved search key. */
async function alertsOf(listingId: string): Promise<Record<string, string[]>> {
  const mine = Object.values(S);
  const list = await rows<{ saved_search_id: string; kind: string }>(sql`
    select saved_search_id, kind from saved_search_alerts
     where listing_id = ${listingId} and saved_search_id = any(${`{${mine.join(',')}}`}::uuid[])
     order by kind`);
  const out: Record<string, string[]> = {};
  for (const [key, id] of Object.entries(S)) {
    const kinds = list.filter((r) => r.saved_search_id === id).map((r) => r.kind);
    if (kinds.length > 0) out[key] = kinds;
  }
  return out;
}

const notificationsOf = (f: Founder) =>
  rows<{ params: Record<string, string | number>; link: string }>(sql`
    select params, link from notifications
     where agency_id = ${f.agencyId} and user_id = ${f.userId} and type = 'SAVED_SEARCH_ALERT'
     order by created_at, id`);

const keysOf = async (id: string) =>
  (await rows<{ match_keys: string[] }>(sql`select match_keys from saved_searches where id = ${id}`))[0]?.match_keys;

beforeAll(async () => {
  await setupTestDb('worker');
  [o, o2, b, u, g, k] = await Promise.all([
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
  ]);
  for (const f of [o, o2, b, g, k]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  await pastGrace(k);
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
  S.graceEnded = (await save(g, { name: 'Grace ended', ...villas })).id;
  S.unverified = await staleNetworkSearch(u, 'Unverified');
  S.locked = await staleNetworkSearch(k, 'Locked');
  // g's grace ends after it saved its network search: its keys are stale until re-keyed
  await pastGrace(g);
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

  it('[S5-06] a network saved search follows network search’s gate: verified, give-to-get not LOCKED', async () => {
    // LOCKED (past grace, nothing shared): refused over the network, its own listings only are fine
    expect(await refusal(save(k, { name: 'Network' }))).toBe('NETWORK_GIVE_TO_GET_LOCKED');
    expect(await refusal(save(k, { name: 'Network only', scope: 'NETWORK' }))).toBe('NETWORK_GIVE_TO_GET_LOCKED');
    const own = await save(k, { name: 'Own stock', scope: 'OWN' });
    expect(await keysOf(own.id)).toEqual([`own:${k.agencyId}:*`]);
    expect(
      await refusal(as(k, (ctx) => matching.updateSavedSearch(ctx, own.id, { name: 'Own stock', scope: 'ALL' }))),
    ).toBe('NETWORK_GIVE_TO_GET_LOCKED');
    // unverified: no network search at all
    expect(await refusal(save(u, { name: 'Network' }))).toBe('VERIFICATION_REQUIRED');
    expect(await refusal(save(u, { name: 'Own', scope: 'OWN' }))).toBe('accepted');
    // an open agency's ALL search carries its own key and the network's
    expect(await keysOf(S.villas as string)).toEqual([`net:*:${ids.city}`, `own:${b.agencyId}:*`]);
  });

  it('[S5-06] at most 50 saved searches per member', async () => {
    const f = await createFounder();
    await system((tx) =>
      tx.execute(sql`insert into saved_searches (id, agency_id, user_id, name, match_keys)
        select gen_random_uuid(), ${f.agencyId}, ${f.userId}, 'Filler ' || g, array['own:' || ${f.agencyId} || ':*']
          from generate_series(1, 50) g`),
    );
    expect(await refusal(save(f, { name: 'One too many', scope: 'OWN' }))).toBe('SAVED_SEARCH_LIMIT');
  });
});

describe('saved search alerts', () => {
  let L1: string;

  it('[S5-06] a read-model change of a listing emits search.listings.changed; a rewrite of the same state does not', async () => {
    L1 = await listing();
    await rebuild([L1]);
    const eventsOf = async () =>
      (
        await rows<{ payload: { listingIds: string[] } }>(sql`
          select payload from outbox_events where type = 'search.listings.changed' and agency_id = ${o.agencyId}`)
      ).filter((e) => e.payload.listingIds.includes(L1)).length;
    const before = await eventsOf();
    expect(before).toBeGreaterThan(0);
    // a read model rewritten without a change of status, price or version (a sanitizer bump, a repair walk)
    await rows(sql`update listing_read_models set etag = 'stale' where target_id = ${L1}`);
    await rebuild([L1]);
    expect(
      (await rows<{ etag: string }>(sql`select etag from listing_read_models where target_id = ${L1}`))[0]?.etag,
    ).not.toBe('stale');
    expect(await eventsOf()).toBe(before);
  });

  it('[S5-06] a new matching listing produces exactly one alert per saved search (deduplicated)', async () => {
    const first = await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    expect(first.transitions).toBe(1);
    // redelivered event, retried job, a second rebuild of the same state: nothing more
    await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    await rebuildAndMatch(L1);
    // not the unverified agency's stale search, not the LOCKED one, not the one whose grace ended
    expect(await alertsOf(L1)).toEqual({ villas: ['NEW'], daily: ['NEW'], newOnly: ['NEW'], owner: ['NEW'] });
    await sendInstant();
    // INSTANT searches: one notification per member after the short window, with a link to the saved searches;
    // DAILY waits for the digest
    const bea = await notificationsOf(b2);
    expect(bea).toHaveLength(1);
    expect(bea[0]).toMatchObject({
      link: '/network/saved-searches',
      params: { kind: 'NEW', count: 1, subject: 'New only' },
    });
    expect((await notificationsOf(b)).map((n) => n.params.subject)).toEqual(['Villas in the city']);
    for (const f of [u, g, k]) expect(await notificationsOf(f)).toHaveLength(0);
    await sendInstant();
    expect(await notificationsOf(b2)).toHaveLength(1);
  });

  it('[S5-06] two jobs for the same new listing at once still alert each saved search once', async () => {
    const L2 = await listing({ priceCents: 45_000_000 });
    await rebuild([L2]);
    await Promise.all([
      matching.matchListings({ agencyId: o.agencyId, listingIds: [L2] }),
      matching.matchListings({ agencyId: o.agencyId, listingIds: [L2] }),
    ]);
    expect(await alertsOf(L2)).toEqual({ villas: ['NEW'], daily: ['NEW'], newOnly: ['NEW'], owner: ['NEW'] });
    await sendInstant();
  });

  it('[S5-06] a price drop alerts once per saved search; a price rise alerts nobody', async () => {
    await update(L1, { priceCents: 55_000_000 });
    expect((await rebuildAndMatch(L1)).transitions).toBe(0);
    await update(L1, { priceCents: 42_000_000 });
    expect((await rebuildAndMatch(L1)).transitions).toBe(1);
    await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    expect(await alertsOf(L1)).toEqual({
      villas: ['NEW', 'PRICE_DROP'],
      daily: ['NEW', 'PRICE_DROP'],
      newOnly: ['NEW'],
      owner: ['NEW', 'PRICE_DROP'],
    });
    const [drop] = await rows<{ price_cents: string; previous_price_cents: string }>(sql`
      select price_cents, previous_price_cents from saved_search_alerts
       where listing_id = ${L1} and saved_search_id = ${S.villas} and kind = 'PRICE_DROP'`);
    expect([Number(drop?.price_cents), Number(drop?.previous_price_cents)]).toEqual([42_000_000, 55_000_000]);
    await sendInstant();
  });

  it('[S5-06] a listing back on the market alerts once per saved search', async () => {
    await update(L1, { status: 'UNDER_OFFER' });
    expect((await rebuildAndMatch(L1)).transitions).toBe(0);
    await update(L1, { status: 'ACTIVE' });
    expect((await rebuildAndMatch(L1)).transitions).toBe(1);
    await matching.matchListings({ agencyId: o.agencyId, listingIds: [L1] });
    expect((await alertsOf(L1)).villas).toEqual(['BACK_ON_MARKET', 'NEW', 'PRICE_DROP']);
    await sendInstant();
  });

  it('[S5-06] the daily digest notifies each member once, re-checking that each listing is still shared', async () => {
    // L3 is alerted (DAILY: waiting), then no longer shared with b before the digest goes out
    const L3 = await listing({ priceCents: 40_000_000 });
    await rebuildAndMatch(L3);
    expect((await alertsOf(L3)).daily).toEqual(['NEW']);
    await update(L3, { shareScope: 'PREFERRED' });
    await rebuildAndMatch(L3);
    await sendInstant();
    const before = (await notificationsOf(b)).length;
    let sent = await matching.sendAlerts(b.agencyId, 'DAILY');
    let dropped = sent.dropped;
    while (sent.more) {
      sent = await matching.sendAlerts(b.agencyId, 'DAILY');
      dropped += sent.dropped;
    }
    const digest = (await notificationsOf(b)).slice(before);
    expect(digest).toHaveLength(1);
    // L1 (new, price drop, back on market) and L2 (new) — L3 dropped: no longer shared with b
    expect(digest[0]?.params).toMatchObject({ kind: 'DIGEST', count: 4, subject: 'Daily sales' });
    expect(String(digest[0]?.params.refs)).not.toContain(
      (await as(o, (ctx) => properties.getListing(ctx, L3))).ref as string,
    );
    expect(dropped).toBe(1);
    expect(await matching.sendAlerts(b.agencyId, 'DAILY')).toMatchObject({ notified: 0 });
  });

  it('[S5-06] other agencies get no alerts about a listing whose owner is not listed (suspended)', async () => {
    const L4 = await listing({}, o2);
    await setAgencyStatus(o2.agencyId, 'SUSPENDED');
    // its read model stays (network paths drop it): a NEW transition, alerting nobody of another agency
    expect((await rebuildAndMatch(L4, o2)).transitions).toBe(1);
    expect(await alertsOf(L4)).toEqual({});
  });

  it('[S5-06] stale network keys alert nobody, and re-keying follows the agency’s network standing', async () => {
    // g's grace ended (LOCKED), u is unverified, k LOCKED: their stale `net:` keys were probed and filtered out above
    expect(await keysOf(S.graceEnded as string)).toContain(`net:*:${ids.city}`);
    expect(await matching.rekeyAgency(g.agencyId)).toMatchObject({ changed: 1, open: false });
    expect(await keysOf(S.graceEnded as string)).toEqual([`own:${g.agencyId}:*`]);
    expect(await matching.rekeyAgency(u.agencyId)).toMatchObject({ open: false });
    expect(await keysOf(S.unverified as string)).toEqual([`own:${u.agencyId}:*`]);
    // b is open: nothing to change; an older key format is rewritten
    await rows(sql`update saved_searches set match_keys = array['*:*'] where id = ${S.villas}`);
    expect(await matching.rekeyAgency(b.agencyId)).toMatchObject({ changed: 1, open: true });
    expect(await keysOf(S.villas as string)).toEqual([`net:*:${ids.city}`, `own:${b.agencyId}:*`]);
    expect(await matching.rekeyAgency(b.agencyId)).toMatchObject({ changed: 0 });
  });

  it('[S5-06] matching a batch of listings costs a bounded number of statements', async () => {
    const batch = [
      await listing(),
      await listing({ priceCents: 30_000_000 }),
      await listing({ propertyTypeId: ids.flat }),
    ];
    await rebuild(batch);
    const n = await countQueries(() => matching.matchListings({ agencyId: o.agencyId, listingIds: batch }));
    expect(n).toBeLessThanOrEqual(16);
    expect(Object.keys(await alertsOf(batch[2] as string)).sort()).toEqual(['daily', 'flats']);
    await sendInstant();
  });

  it('[S5-06] candidates are read a few listings per statement, never cut short', async () => {
    const doc = (await system((tx) => search.indexDocsFor(tx, [L1], { text: false }))).docs[0];
    if (!doc) throw new Error('no doc');
    const probe: ListingProbe = {
      listingId: doc.id,
      ownerAgencyId: doc.ownerAgencyId,
      kind: 'NEW',
      keys: listingKeys({ ...doc, network: true }),
      transactionType: doc.transactionType,
      locationIds: doc.locationIds,
      propertyTypeId: doc.propertyTypeId,
      featureIds: doc.featureIds,
      priceCents: doc.priceCents,
      beds: doc.beds,
      baths: doc.baths,
      areaM2: doc.areaM2,
      network: true,
      shareAll: true,
      preferredAgencyIds: [],
    };
    const single = await system((tx) => matchCandidates(tx, [probe]));
    const probes = [probe, { ...probe, listingId: newId() }, { ...probe, listingId: newId() }];
    const pairs = (cs: { listingId: string; savedSearchId: string }[]) =>
      cs.map((c) => `${c.listingId}:${c.savedSearchId}`).sort();
    const whole = await system((tx) => matchCandidates(tx, probes));
    const chunked = await system((tx) => matchCandidates(tx, probes, 1));
    expect(single.length).toBeGreaterThan(2);
    expect(whole).toHaveLength(3 * single.length);
    expect(pairs(chunked)).toEqual(pairs(whole));
  });

  it('[S5-06] the backfill records existing listings’ states, so their first change after deploy alerts', async () => {
    const L5 = await listing({ priceCents: 52_000_000 });
    await rebuild([L5]);
    // a listing from before deploy: never seen by matching, its read model weeks old
    await rows(sql`delete from matching_listing_states where listing_id = ${L5}`);
    await rows(sql`update listing_read_models set created_at = now() - interval '30 days' where target_id = ${L5}`);
    const [prev] = await rows<{ id: string | null }>(sql`
      select max(target_id::text)::uuid as id from listing_read_models where target_id < ${L5}`);
    expect(await matching.backfillListingStates(prev?.id ?? null, 1)).toMatchObject({ inserted: 1, next: L5 });
    await update(L5, { priceCents: 41_000_000 });
    expect((await rebuildAndMatch(L5)).transitions).toBe(1);
    expect((await alertsOf(L5)).villas).toEqual(['PRICE_DROP']);
  });

  it('[S5-06] the matching query probes the GIN inverse index, never every saved search (EXPLAIN, 60k searches)', async () => {
    const probes: ListingProbe[] = [
      {
        listingId: newId(),
        ownerAgencyId: o.agencyId,
        kind: 'NEW',
        keys: listingKeys({
          ownerAgencyId: o.agencyId,
          transactionType: 'SALE',
          locationIds: [ids.country, ids.city, ids.area],
          network: true,
        }),
        transactionType: 'SALE',
        locationIds: [ids.country, ids.city, ids.area],
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
      // 60k saved searches of other places and of other agencies' own stock (broad ones included)
      await q(
        `insert into saved_searches (id, agency_id, user_id, name, match_keys)
         select gen_random_uuid(), $1, gen_random_uuid(), 'Bulk ' || g,
                case when g % 2 = 0
                  then array['net:' || (case when g % 3 = 0 then 'SALE' else 'RENT_LONG_TERM' end) || ':' || md5((g % 2000)::text)]
                  else array['own:' || md5(g::text)::uuid || ':*'] end
           from generate_series(1, 60000) g`,
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
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'saved_searches')).toBe(false);
    const index = nodes.find((n) => n['Node Type'] === 'Bitmap Index Scan');
    expect(index?.['Index Name']).toBe('saved_searches_match_keys_idx');
    // the candidates read: this file's and other suites' searches of these places, never the 60k
    const heap = nodes.find((n) => n['Node Type'] === 'Bitmap Heap Scan');
    expect(Number(heap?.['Actual Rows'] ?? 0) * Number(heap?.['Actual Loops'] ?? 1)).toBeLessThan(2_000);
    const ms = (plan as { 'Execution Time': number }[])[0]?.['Execution Time'];
    // the hot-path SQL budget (< 20 ms p95)
    expect(ms).toBeLessThan(20);
    console.info(
      `[S5-06] matching plan: ${nodes.map((n) => `${n['Node Type']}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`).join(' → ')}, ` +
        `${heap?.['Actual Rows']} candidates, ${ms} ms`,
    );
  }, 120_000);
});
