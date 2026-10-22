import { CreateFeedConnectionBody, type FeedConnectionDto, type FeedListingInput } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as imports from '../index';
import { memoryConnector } from './test-connectors';

/** The bulk loader (S6-02): staging → MERGE, hashes, locks, holds and promotion, withdrawals, images, events. */

const RUN = newId().slice(-8).toLowerCase();
const log = createLogger({
  service: 'imports-loader-test',
  level: (process.env.TEST_LOG as 'warn' | undefined) ?? 'silent',
});
const job = () => ({ log, signal: new AbortController().signal, lastAttempt: true });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.loader.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: `${slug}-${RUN}` }];

let owner: Founder;
let staffId: string;
const undo: (() => void)[] = [];
/** The feed each connector serves on its next run, by connector key. */
const feeds = new Map<string, FeedListingInput[]>();

const names = {
  country: `Loadonia ${RUN}`,
  region: `Costa Cargada ${RUN}`,
  city: `Villa Staging ${RUN}`,
  area: `Merge Hills ${RUN}`,
  type: `Loader Villa ${RUN}`,
  pool: `Loader Pool ${RUN}`,
  view: `Loader View ${RUN}`,
};
const ids = { country: '', region: '', city: '', area: '', type: '', pool: '', view: '' };

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: owner.userId, agencyId: owner.agencyId, requestId: newId(), locale: 'en' }, fn);

function listing(ref: string, over: Partial<FeedListingInput> = {}): FeedListingInput {
  return {
    ref,
    transactionType: 'SALE',
    priceCents: 350_000_00,
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 180,
    energyRating: 'C',
    coordinates: { lat: 36.51, lng: -4.88 },
    propertyType: names.type,
    location: { country: names.country, region: names.region, city: names.city, area: names.area },
    features: [names.pool],
    translations: [{ locale: 'en', title: `Villa ${ref}`, description: 'Sea views.' }],
    ...over,
  };
}

/** A connection whose feed is `feeds.get(key)`, with its own connector. */
async function connection(
  settings: Record<string, string | number> = {},
): Promise<FeedConnectionDto & { key: string }> {
  const key = `mem-${newId().slice(-10).toLowerCase()}`;
  feeds.set(key, []);
  undo.push(imports.registerConnector(memoryConnector(key, () => feeds.get(key) ?? [])));
  const c = await as((ctx) =>
    imports.createFeedConnection(
      ctx,
      CreateFeedConnectionBody.parse({
        name: 'Loader feed',
        connector: key,
        url: 'https://feeds.example.com/loader.xml',
        scheduleMinutes: null,
        settings,
      }),
    ),
  );
  return { ...c, key };
}

async function runFeed(c: { id: string; key: string }, items: FeedListingInput[]) {
  feeds.set(c.key, items);
  const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
  const outcome = await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
  const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
  return { outcome, run: dto };
}

interface ListingState {
  id: string;
  ref: string;
  external_ref: string;
  status: string;
  price_cents: string | null;
  bedrooms: number | null;
  location_id: string;
  city_id: string | null;
  property_type_id: string;
  version: number;
  locked_fields: string[];
  import_held: string[] | null;
  import_missed_runs: number;
  commission_bp: number | null;
  split_bp: number | null;
  owner_user_id: string;
  source: string;
}

async function listingsOf(c: { id: string }): Promise<Map<string, ListingState>> {
  const list = await rows<ListingState>(sql`
    select p.id, p.ref, pp.external_ref, p.status, p.price_cents, p.bedrooms, p.location_id, p.city_id,
           p.property_type_id, p.version, p.locked_fields, pp.import_held, pp.import_missed_runs, p.commission_bp,
           p.split_bp, p.owner_user_id, p.source
      from properties p join property_privates pp on pp.property_id = p.id
     where p.agency_id = ${owner.agencyId} and pp.import_connection_id = ${c.id}`);
  return new Map(list.map((l) => [l.external_ref, l]));
}

/** Every row version of the agency's listings and their children (xmin changes when a row is written). */
async function rowVersions(): Promise<string> {
  const [r] = await rows<{ v: string }>(sql`
    select concat_ws('|',
      (select string_agg(id || ':' || xmin::text, ',' order by id) from properties where agency_id = ${owner.agencyId}),
      (select string_agg(property_id || ':' || xmin::text, ',' order by property_id) from property_privates
        where agency_id = ${owner.agencyId}),
      (select string_agg(property_id || locale || ':' || xmin::text, ',' order by property_id, locale)
         from property_translations where agency_id = ${owner.agencyId}),
      (select string_agg(property_id::text || feature_id::text || ':' || xmin::text, ',' order by property_id, feature_id)
         from property_features where agency_id = ${owner.agencyId}),
      (select count(*)::text from property_status_histories where agency_id = ${owner.agencyId}),
      (select count(*)::text from property_price_histories where agency_id = ${owner.agencyId}),
      (select count(*)::text from feed_image_queue where agency_id = ${owner.agencyId})) as v`);
  return r?.v ?? '';
}

const listingEvents = async (since: Date) =>
  (
    await rows<{ n: string }>(sql`
      select count(*)::text as n from outbox_events
       where agency_id = ${owner.agencyId} and type like 'properties.%' and created_at >= ${since.toISOString()}::timestamptz`)
  )[0]?.n;

/** Staff map a queued value to `targetId` (S2-05 queue → alias), as the data ops team would. */
async function staffMap(kind: 'location' | 'propertyType' | 'feature', value: string, targetId: string) {
  const [row] = await rows<{ id: string }>(
    sql`select id from taxonomy_unmatched where kind = ${kind} and value_key = ${taxonomy.aliasKey(value)}`,
  );
  if (!row) throw new Error(`nothing queued for ${kind} ${value}`);
  await withStaffCtx({ userId: staffId, requestId: newId(), reason: 'loader test' }, (ctx) =>
    taxonomy.mapStaffUnmatched(ctx, row.id, { targetId }),
  );
}

beforeAll(async () => {
  await setupTestDb('worker');
  imports.configureImports({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    withdrawAfterMissedRuns: 3,
  });
  owner = await createFounder();
  staffId = (await createStaffUser('STAFF_DATA_OPS')).userId;
  await system(async (tx) => {
    ids.country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ld-c-${RUN}`,
      translations: tr(names.country, 'loadonia'),
    });
    ids.region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: ids.country,
      code: `ld-r-${RUN}`,
      translations: tr(names.region, 'costa-cargada'),
    });
    ids.city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: ids.region,
      code: `ld-ci-${RUN}`,
      translations: tr(names.city, 'villa-staging'),
    });
    ids.area = await taxonomy.createLocation(tx, {
      level: 'AREA',
      parentId: ids.city,
      code: `ld-a-${RUN}`,
      translations: tr(names.area, 'merge-hills'),
    });
    const typeGroup = await taxonomy.createPropertyTypeGroup(tx, {
      key: `ld-houses-${RUN}`,
      sort: 0,
      translations: tr(`Loader Houses ${RUN}`, 'loader-houses'),
    });
    ids.type = await taxonomy.createPropertyType(tx, {
      groupId: typeGroup,
      key: `ld-villa-${RUN}`,
      sort: 0,
      translations: tr(names.type, 'loader-villa'),
    });
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: `ld-outdoor-${RUN}`,
      sort: 0,
      translations: tr(`Loader Outdoor ${RUN}`, 'loader-outdoor'),
    });
    ids.pool = await taxonomy.createFeature(tx, {
      groupId: featureGroup,
      key: `ld-pool-${RUN}`,
      sort: 0,
      icon: 'waves',
      translations: tr(names.pool, 'loader-pool'),
    });
    ids.view = await taxonomy.createFeature(tx, {
      groupId: featureGroup,
      key: `ld-view-${RUN}`,
      sort: 1,
      icon: 'eye',
      translations: tr(names.view, 'loader-view'),
    });
  });
}, 120_000);

afterAll(async () => {
  for (const u of undo) u();
  await closeDb();
});

describe('bulk loader', () => {
  it('[S7-F10] a run over several batches queues an unknown value once and counts every sighting at its end (runner)', async () => {
    const c = await connection();
    const unseen = `Qzx Unseen ${RUN}`;
    // 1,200 items: three batches of 500; every 50th names an area no location has (24 sightings, 10 + 10 + 4).
    const items = Array.from({ length: 1_200 }, (_, i) =>
      listing(`UQ-${i}`, i % 50 === 7 ? { location: { ...listing('x').location, area: unseen } } : {}),
    );
    const queueWrites = await countQueries(() => runFeed(c, items), { match: /insert into "taxonomy_unmatched"/ });
    // The first batch queues it; the other batches' sightings ride on no write of their own; the runner's end-of-run
    // hook (after the run's transaction committed) adds them in one write.
    expect(queueWrites).toBe(2);
    const [row] = await rows<{ count: number; examples: string[] }>(
      sql`select count, examples from taxonomy_unmatched where kind = 'location' and value_key = ${taxonomy.aliasKey(unseen)}`,
    );
    expect(row?.count).toBe(24);
    expect(row?.examples.length).toBeGreaterThan(1);
    expect(row?.examples[0]).toBe('UQ-1157'); // the newest sighting first
  });

  it('[S6-02] a feed becomes listings: taxonomy resolved per level, owner, agency commission, children, one event per 250', async () => {
    const c = await connection();
    const items = Array.from({ length: 260 }, (_, i) => listing(`A-${i}`));
    const since = new Date();
    const { outcome, run } = await runFeed(c, items);
    expect(outcome).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    expect(run.counts).toMatchObject({ total: 260, valid: 260, failed: 0, created: 260, updated: 0, held: 0 });

    const stored = await listingsOf(c);
    expect(stored.size).toBe(260);
    const a0 = stored.get('A-0') as ListingState;
    expect(a0).toMatchObject({
      status: 'ACTIVE',
      price_cents: '35000000',
      location_id: ids.area,
      city_id: ids.city,
      property_type_id: ids.type,
      owner_user_id: owner.userId,
      commission_bp: 500,
      split_bp: 5000,
      source: imports.sourceOf(c.key),
      version: 1,
      import_held: null,
    });
    expect(a0.ref).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    const [children] = await rows<{ tr: string; ft: string; sh: string; ph: string }>(sql`
      select (select count(*) from property_translations where property_id = ${a0.id})::text as tr,
             (select count(*) from property_features where property_id = ${a0.id} and feature_id = ${ids.pool})::text as ft,
             (select count(*) from property_status_histories where property_id = ${a0.id} and to_status = 'ACTIVE')::text as sh,
             (select count(*) from property_price_histories where property_id = ${a0.id} and price_cents = 35000000)::text as ph`);
    expect(children).toEqual({ tr: '1', ft: '1', sh: '1', ph: '1' });

    // 260 listings in one batch: two `properties.listings.imported` events (250 + 10), no per-listing events.
    const events = await rows<{ type: string; n: number }>(sql`
      select type, jsonb_array_length(payload -> 'listingIds') as n from outbox_events
       where agency_id = ${owner.agencyId} and type like 'properties.%' and created_at >= ${since.toISOString()}::timestamptz
       order by n desc`);
    expect(events).toEqual([
      { type: 'properties.listings.imported', n: 250 },
      { type: 'properties.listings.imported', n: 10 },
    ]);
  });

  it('[S6-02] re-importing an unchanged feed changes 0 rows and emits 0 events', async () => {
    const c = await connection();
    const items = Array.from({ length: 40 }, (_, i) =>
      listing(`U-${i}`, { images: [`https://img.example.com/${RUN}/u-${i}.jpg`] }),
    );
    await runFeed(c, items);
    const before = await rowVersions();
    const since = new Date();
    const { run } = await runFeed(c, items);
    expect(run.counts).toMatchObject({ valid: 40, created: 0, updated: 0, unchanged: 40, withdrawn: 0 });
    expect(await rowVersions()).toBe(before);
    expect(await listingEvents(since)).toBe('0');
    // the run's own bookkeeping is all it wrote: no seen references left behind
    expect(await rows(sql`select 1 from property_import_seen where run_id = ${run.id}`)).toEqual([]);
  });

  it('[S6-02] locked fields survive re-import; unlocked ones follow the feed', async () => {
    const c = await connection();
    await runFeed(c, [listing('L-1')]);
    const first = (await listingsOf(c)).get('L-1') as ListingState;
    await as((ctx) =>
      properties.updateListing(ctx, first.id, {
        version: first.version,
        priceCents: 300_000_00,
        bedrooms: 5,
        lockedFields: ['features', 'price', 'specs'],
      }),
    );
    const { run } = await runFeed(c, [
      listing('L-1', {
        priceCents: 399_000_00,
        bedrooms: 4,
        features: [names.view],
        translations: [{ locale: 'en', title: 'Renamed villa', description: null }],
      }),
    ]);
    expect(run.counts).toMatchObject({ updated: 1 });
    const after = (await listingsOf(c)).get('L-1') as ListingState;
    expect(after).toMatchObject({ price_cents: '30000000', bedrooms: 5 });
    expect([...after.locked_fields].sort()).toEqual(['features', 'price', 'specs']);
    const features = await rows<{ feature_id: string }>(
      sql`select feature_id from property_features where property_id = ${first.id}`,
    );
    expect(features.map((f) => f.feature_id)).toEqual([ids.pool]);
    expect(after.version).toBe(first.version + 2);
    const [t] = await rows<{ title: string }>(
      sql`select title from property_translations where property_id = ${first.id} and locale = 'en'`,
    );
    expect(t?.title).toBe('Renamed villa');
    // a locked status survives a withdrawal too (below), and a locked price writes no price history
    const [h] = await rows<{ n: string }>(
      sql`select count(*)::text as n from property_price_histories where property_id = ${first.id} and price_cents = 39900000`,
    );
    expect(h?.n).toBe('0');
  });

  it('[S6-02] two feeds of one format in an agency keep their own listings (references match per connection)', async () => {
    const key = `mem-shared-${RUN}`;
    const byConnection = new Map<string, FeedListingInput[]>();
    undo.push(imports.registerConnector(memoryConnector(key, (id) => byConnection.get(id) ?? [])));
    const make = (name: string) =>
      as((ctx) =>
        imports.createFeedConnection(
          ctx,
          CreateFeedConnectionBody.parse({
            name,
            connector: key,
            url: 'https://feeds.example.com/shared.xml',
            scheduleMinutes: null,
          }),
        ),
      );
    const a = { ...(await make('Feed A')), key };
    const b = { ...(await make('Feed B')), key };
    byConnection.set(a.id, [listing('S-1', { priceCents: 100_000_00 })]);
    byConnection.set(b.id, [listing('S-1', { priceCents: 200_000_00 })]);
    const run = async (c: { id: string }) => {
      const r = await as((ctx) => imports.requestFeedRun(ctx, c.id));
      await imports.executeRun({ runId: r.id, agencyId: owner.agencyId }, job());
      return as((ctx) => imports.getFeedRun(ctx, r.id));
    };
    expect((await run(a)).counts).toMatchObject({ created: 1 });
    expect((await run(b)).counts).toMatchObject({ created: 1 });
    // again: neither overwrites the other's listing
    expect((await run(a)).counts).toMatchObject({ unchanged: 1 });
    expect((await run(b)).counts).toMatchObject({ unchanged: 1 });
    expect((await listingsOf(a)).get('S-1')).toMatchObject({ price_cents: '10000000' });
    expect((await listingsOf(b)).get('S-1')).toMatchObject({ price_cents: '20000000' });
  });

  it('[S6-02] a listing held as DRAFT for an unmatched location level or feature is promoted on the next run after staff map the value', async () => {
    const c = await connection();
    const area = `Unmapped Cove ${RUN}`;
    const feature = `Rooftop Jacuzzi ${RUN}`;
    const items = [
      listing('H-loc', { location: { country: names.country, region: names.region, city: names.city, area } }),
      listing('H-feat', { features: [names.pool, feature] }),
    ];
    const first = await runFeed(c, items);
    expect(first.run.counts).toMatchObject({ created: 2, held: 2 });
    let stored = await listingsOf(c);
    // held at the deepest level that matched (the city), as DRAFT, with the reason
    expect(stored.get('H-loc')).toMatchObject({ status: 'DRAFT', location_id: ids.city, import_held: ['location'] });
    expect(stored.get('H-feat')).toMatchObject({ status: 'DRAFT', import_held: ['feature'] });
    // both values wait in the staff queue; the area was resolved under its city (the parent hint)
    expect(
      await rows(
        sql`select 1 from taxonomy_unmatched where kind = 'location' and value_key = ${taxonomy.aliasKey(area)}`,
      ),
    ).toHaveLength(1);

    // An unchanged feed before staff act keeps them held, writing nothing.
    expect((await runFeed(c, items)).run.counts).toMatchObject({ updated: 0, unchanged: 2, held: 2 });

    await staffMap('location', area, ids.area);
    await staffMap('feature', feature, ids.view);
    const promoted = await runFeed(c, items);
    expect(promoted.run.counts).toMatchObject({ updated: 2, held: 0 });
    stored = await listingsOf(c);
    expect(stored.get('H-loc')).toMatchObject({ status: 'ACTIVE', location_id: ids.area, import_held: null });
    expect(stored.get('H-feat')).toMatchObject({ status: 'ACTIVE', import_held: null });
    const [f] = await rows<{ n: string }>(sql`
      select count(*)::text as n from property_features where property_id = ${stored.get('H-feat')?.id}`);
    expect(f?.n).toBe('2');
  });

  it('[S6-02] an unmatched property type holds an existing listing and keeps a new one out until staff map it', async () => {
    const c = await connection();
    const type = `Cortijo Raro ${RUN}`;
    await runFeed(c, [listing('T-old')]);
    const { run } = await runFeed(c, [
      listing('T-old', { propertyType: type }),
      listing('T-new', { propertyType: type }),
    ]);
    // the existing listing keeps its type and is held; the new one cannot be stored without a type
    expect(run.counts).toMatchObject({ valid: 1, failed: 1, updated: 1, held: 1, created: 0 });
    const errors = await as((ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 10 }));
    expect(errors.items).toMatchObject([{ itemRef: 'T-new', code: 'PROPERTY_TYPE_UNMATCHED', field: 'propertyType' }]);
    let stored = await listingsOf(c);
    expect(stored.get('T-old')).toMatchObject({
      status: 'DRAFT',
      property_type_id: ids.type,
      import_held: ['propertyType'],
    });
    expect(stored.has('T-new')).toBe(false);

    const otherType = await system(async (tx) => {
      const [g] = (await tx.execute(sql`select group_id from property_types where id = ${ids.type}`)).rows as {
        group_id: string;
      }[];
      return taxonomy.createPropertyType(tx, {
        groupId: g?.group_id as string,
        key: `ld-cortijo-${RUN}`,
        sort: 1,
        translations: tr(`Loader Farmhouse ${RUN}`, 'loader-farmhouse'),
      });
    });
    await staffMap('propertyType', type, otherType);
    const next = await runFeed(c, [listing('T-old', { propertyType: type }), listing('T-new', { propertyType: type })]);
    expect(next.run.counts).toMatchObject({ valid: 2, failed: 0, created: 1, updated: 1, held: 0 });
    stored = await listingsOf(c);
    expect(stored.get('T-old')).toMatchObject({ status: 'ACTIVE', property_type_id: otherType, import_held: null });
    expect(stored.get('T-new')).toMatchObject({ status: 'ACTIVE', property_type_id: otherType });
  });

  it('[S6-02] a listing missing from the feed for N runs (connection setting) is WITHDRAWN, a locked status stays, and the feed brings it back', async () => {
    const c = await connection({ withdrawAfterMissedRuns: 2 });
    const all = [listing('W-1'), listing('W-2'), listing('W-keep')];
    await runFeed(c, all);
    const locked = (await listingsOf(c)).get('W-2') as ListingState;
    await as((ctx) => properties.updateListing(ctx, locked.id, { version: locked.version, lockedFields: ['status'] }));

    const only = [listing('W-keep')];
    expect((await runFeed(c, only)).run.counts).toMatchObject({ withdrawn: 0 });
    let stored = await listingsOf(c);
    expect(stored.get('W-1')).toMatchObject({ status: 'ACTIVE', import_missed_runs: 1 });

    const second = await runFeed(c, only);
    expect(second.run.counts).toMatchObject({ withdrawn: 1 });
    stored = await listingsOf(c);
    expect(stored.get('W-1')).toMatchObject({ status: 'WITHDRAWN', import_missed_runs: 2 });
    expect(stored.get('W-2')).toMatchObject({ status: 'ACTIVE', import_missed_runs: 2 });
    expect(stored.get('W-keep')).toMatchObject({ status: 'ACTIVE', import_missed_runs: 0 });

    // a third run without them writes nothing more for them (counting stops at N)
    const v = (await listingsOf(c)).get('W-1')?.version;
    await runFeed(c, only);
    expect((await listingsOf(c)).get('W-1')?.version).toBe(v);

    // listed again, unchanged: back on the market, the miss count reset
    const back = await runFeed(c, all);
    expect(back.run.counts).toMatchObject({ updated: 1, unchanged: 2 });
    stored = await listingsOf(c);
    expect(stored.get('W-1')).toMatchObject({ status: 'ACTIVE', import_missed_runs: 0 });
    expect(stored.get('W-2')).toMatchObject({ import_missed_runs: 0 });
  });

  it('[S6-02] withdrawals default to IMPORT_WITHDRAW_AFTER_MISSED_RUNS; failed items and an empty feed withdraw nothing', async () => {
    const c = await connection();
    await runFeed(c, [listing('D-1'), listing('D-2')]);
    // D-2 fails validation but is still in the feed: never counted missing
    const broken = { ...listing('D-2'), transactionType: 'SALE' as const, pricePeriod: 'MONTH' as const };
    for (let i = 0; i < 3; i++) await runFeed(c, [listing('D-1'), broken]);
    expect((await listingsOf(c)).get('D-2')).toMatchObject({ status: 'ACTIVE', import_missed_runs: 0 });
    // a feed with nothing valid is a broken feed, not an empty portfolio: it pauses (S7-F1) and, even when the
    // agency accepts it, withdraws nothing and counts no miss
    expect((await runFeed(c, [])).run).toMatchObject({ errorCode: 'FEED_PAUSED_EMPTY_FEED' });
    for (let i = 0; i < 3; i++) {
      await as((ctx) => imports.resumeFeedConnection(ctx, c.id, { acceptChange: true }));
      expect((await runFeed(c, [])).run).toMatchObject({ state: 'SUCCEEDED', counts: { withdrawn: 0 } });
      // the acceptance is used up: the next empty run pauses again
      expect((await runFeed(c, [])).run).toMatchObject({ errorCode: 'FEED_PAUSED_EMPTY_FEED' });
    }
    await as((ctx) => imports.resumeFeedConnection(ctx, c.id, { acceptChange: false }));
    expect((await listingsOf(c)).get('D-1')).toMatchObject({ status: 'ACTIVE', import_missed_runs: 0 });
    // three successful runs without D-1 (the configured default, 3) withdraw it
    for (let i = 0; i < 3; i++) await runFeed(c, [broken, listing('D-3')]);
    expect((await listingsOf(c)).get('D-1')).toMatchObject({ status: 'WITHDRAWN', import_missed_runs: 3 });
  });

  it('[S6-02] images are queued for new listings and changed image lists only, in feed order', async () => {
    const c = await connection();
    const url = (n: string) => `https://img.example.com/${RUN}/${n}.jpg`;
    await runFeed(c, [listing('I-1', { images: [url('a'), url('b')] }), listing('I-2')]);
    const id1 = (await listingsOf(c)).get('I-1')?.id as string;
    const queued = () =>
      rows<{ property_id: string; urls: string[] }>(
        sql`select property_id, urls from feed_image_queue where agency_id = ${owner.agencyId} and property_id in
              (select property_id from property_privates where import_connection_id = ${c.id})`,
      );
    expect(await queued()).toEqual([{ property_id: id1, urls: [url('a'), url('b')] }]);
    const [event] = await rows<{ n: string }>(sql`
      select count(*)::text as n from outbox_events where agency_id = ${owner.agencyId} and type = 'media.feedImages.queued'
         and payload ->> 'listings' = '1'`);
    expect(Number(event?.n)).toBeGreaterThanOrEqual(1);

    await system((tx) => tx.execute(sql`delete from feed_image_queue where property_id = ${id1}`));
    // a price change alone queues nothing; a new image list does
    await runFeed(c, [listing('I-1', { images: [url('a'), url('b')], priceCents: 1 }), listing('I-2')]);
    expect(await queued()).toEqual([]);
    await runFeed(c, [listing('I-1', { images: [url('b'), url('c')] }), listing('I-2')]);
    expect(await queued()).toEqual([{ property_id: id1, urls: [url('b'), url('c')] }]);
  });

  it('[S6-02] a batch costs the same handful of statements whatever its size; item problems become per-item errors', async () => {
    const small = await connection();
    const large = await connection();
    const feed = (n: number, prefix: string) => {
      const items: FeedListingInput[] = Array.from({ length: n }, (_, i) => listing(`${prefix}-${i}`));
      items.push({ ...listing(`${prefix}-bad`), bedrooms: -1 });
      return items;
    };
    // The batch's listing writes (staging, MERGE, children, seen, events, image queue) — created, then updated: both
    // MERGE paths, each one batch. Run bookkeeping and caches stay out of the count.
    const match =
      /property_import_staging|merge into properties|property_privates|property_translations|property_features|property_import_seen|property_status_histories|property_price_histories|outbox_events|feed_image_queue/;
    const statements = async (c: { id: string; key: string }, n: number, prefix: string) => {
      const created = await countQueries(() => runFeed(c, feed(n, prefix)), { match });
      const updated = await countQueries(
        () =>
          runFeed(
            c,
            feed(n, prefix).map((l) => ({ ...l, priceCents: 1 })),
          ),
        { match },
      );
      return { created, updated };
    };
    await runFeed(await connection(), [listing('QW-1')]); // warm the agency settings cache (a run reads it once)
    const few = await statements(small, 5, 'QS');
    const many = await statements(large, 400, 'QL');
    expect(many).toEqual(few);
    // 16 for the batch (no image queue here: 15) and the run's own: its requested/finished events and the end-of-run
    // miss count and seen cleanup; S6-08 adds the anomaly guard's drop count and the freshness-via-feed lookup
    expect(few.created).toBeLessThanOrEqual(22);

    const { run } = await runFeed(large, feed(400, 'QL'));
    expect(run.counts).toMatchObject({ total: 401, valid: 400, failed: 1, updated: 400 });
    const errors = await as((ctx) => imports.listFeedItemErrors(ctx, run.id, { limit: 10 }));
    expect(errors.items).toMatchObject([{ itemRef: 'QL-bad', code: 'INVALID_ITEM', field: 'bedrooms' }]);
  });

  it('[S7-F2] a feed with the same ref in two batches updates the listing once; the later item is a DUPLICATE_REF error', async () => {
    const c = await connection();
    // 520 items: batch 1 holds DP-0 … DP-499, batch 2 the rest and DP-7 again at position 520 (another price)
    const feed = (firstPrice: number) => [
      ...Array.from({ length: 520 }, (_, i) =>
        listing(`DP-${i}`, i === 7 ? { priceCents: firstPrice } : { priceCents: 200_000_00 + i * 100 }),
      ),
      listing('DP-7', { priceCents: 999_999_00 }),
    ];
    const first = await runFeed(c, feed(310_000_00));
    expect(first.outcome).toMatchObject({ state: 'SUCCEEDED' });
    expect(first.run.counts).toMatchObject({ total: 521, valid: 520, failed: 1, created: 520, updated: 0 });
    const errors = await as((ctx) => imports.listFeedItemErrors(ctx, first.run.id, { limit: 10 }));
    expect(errors.items).toMatchObject([{ position: 520, itemRef: 'DP-7', code: 'DUPLICATE_REF', field: 'ref' }]);
    const created = await listingsOf(c);
    expect(created.size).toBe(520);
    expect(created.get('DP-7')?.price_cents).toBe(String(310_000_00)); // the first item wins
    const versionBefore = created.get('DP-7')?.version as number;

    // only the first DP-7 changes: one listing updated, once — not twice, and not counted twice
    const second = await runFeed(c, feed(320_000_00));
    expect(second.run.counts).toMatchObject({
      total: 521,
      valid: 520,
      failed: 1,
      created: 0,
      updated: 1,
      unchanged: 519,
    });
    const after = (await listingsOf(c)).get('DP-7');
    expect(after?.price_cents).toBe(String(320_000_00));
    expect(after?.version).toBe(versionBefore + 1);
  });

  it('[S7-F2] a run claimed again starts with no seen references, so its earlier attempt’s items are not duplicates', async () => {
    const c = await connection();
    feeds.set(c.key, [listing('RA-1'), listing('RA-2')]);
    const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
    // what a released attempt leaves behind: its attempt count and the references it saw
    await system(async (tx) => {
      await tx.execute(sql`update feed_runs set attempt = 1 where id = ${run.id}`);
      await tx.execute(sql`insert into property_import_seen (agency_id, run_id, external_ref)
                           values (${owner.agencyId}, ${run.id}, 'RA-1'), (${owner.agencyId}, ${run.id}, 'RA-2')`);
    });
    await imports.executeRun({ runId: run.id, agencyId: owner.agencyId }, job());
    const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
    expect(dto.counts).toMatchObject({ total: 2, valid: 2, failed: 0, created: 2 });
  });

  it('[S7-F3] seen references lost mid-run (UNLOGGED table emptied by a crash) restart the run instead of counting listings missing', async () => {
    const c = await connection({ withdrawAfterMissedRuns: 1 });
    const items = Array.from({ length: 600 }, (_, i) => listing(`SL-${i}`));
    await runFeed(c, items); // the listings exist; one missed run would withdraw them

    // the feed parks after its first committed batch (500 refs seen); meanwhile the table loses the run's rows
    let reached!: () => void;
    let open!: () => void;
    const parked = new Promise<void>((r) => {
      reached = r;
    });
    const opened = new Promise<void>((r) => {
      open = r;
    });
    const restore = imports.registerConnector({
      ...memoryConnector(c.key, () => items),
      async *parse() {
        for (const [i, raw] of items.entries()) {
          if (i === 501) {
            reached();
            await opened;
          }
          yield { position: i, raw };
        }
      },
    });
    const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
    const p = { runId: run.id, agencyId: owner.agencyId };
    const first = imports.executeRun(p, { ...job(), lastAttempt: false });
    await parked;
    // what a crash or a failover does to an UNLOGGED table (scoped to this run: other suites share the table)
    await system((tx) => tx.execute(sql`delete from property_import_seen where run_id = ${run.id}`));
    open();
    await expect(first).rejects.toMatchObject({ name: 'SeenRefsLostError', expected: 600, actual: 100 });
    restore();
    // handed back to the queue: nothing counted missing, nothing withdrawn, the connection not paused
    const [state] = await rows<{ state: string; paused: boolean }>(sql`
      select r.state, c.paused_at is not null as paused
        from feed_runs r join feed_connections c on c.id = r.connection_id where r.id = ${run.id}`);
    expect(state).toEqual({ state: 'QUEUED', paused: false });
    expect(
      [...(await listingsOf(c)).values()].filter((l) => l.import_missed_runs > 0 || l.status === 'WITHDRAWN'),
    ).toEqual([]);
    // the next attempt starts over from a clean slate and succeeds
    feeds.set(c.key, items);
    expect(await imports.executeRun(p, job())).toMatchObject({ kind: 'finished', state: 'SUCCEEDED' });
    const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
    expect(dto.counts).toMatchObject({ total: 600, valid: 600, withdrawn: 0 });
    expect([...(await listingsOf(c)).values()].filter((l) => l.status === 'WITHDRAWN')).toHaveLength(0);
  });

  it('[S7-F2] a stale attempt that resumes after another worker claimed the run loses no seen references and withdraws nothing', async () => {
    const c = await connection({ withdrawAfterMissedRuns: 1 });
    const items = Array.from({ length: 600 }, (_, i) => listing(`SW-${i}`));
    await runFeed(c, items); // the listings exist; one missed run would withdraw them

    // the new owner's feed parks after its first committed batch (500 refs seen)
    const parked = { reached: () => {}, open: () => {} };
    const reached = new Promise<void>((r) => {
      parked.reached = r;
    });
    const opened = new Promise<void>((r) => {
      parked.open = r;
    });
    undo.push(
      imports.registerConnector({
        ...memoryConnector(c.key, () => items),
        async *parse() {
          for (const [i, raw] of items.entries()) {
            if (i === 501) {
              parked.reached();
              await opened;
            }
            yield { position: i, raw };
          }
        },
      }),
    );
    // the stale worker claims, then stalls before its sink starts (a slow owner lookup)
    let staleEntered!: () => void;
    let staleGo!: () => void;
    const staleInStart = new Promise<void>((r) => {
      staleEntered = r;
    });
    const staleMayGo = new Promise<void>((r) => {
      staleGo = r;
    });
    const staleSink: imports.FeedSink = {
      ...imports.listingSink,
      async start(r) {
        staleEntered();
        await staleMayGo;
        return imports.listingSink.start(r);
      },
    };
    const run = await as((ctx) => imports.requestFeedRun(ctx, c.id));
    const p = { runId: run.id, agencyId: owner.agencyId };
    const stale = imports.executeRun(p, job(), staleSink);
    await staleInStart;
    await system((tx) =>
      tx.execute(sql`update feed_runs set lease_until = now() - interval '1 minute' where id = ${run.id}`),
    );
    const owned = imports.executeRun(p, job()); // attempt 2
    await reached;
    staleGo(); // the stale worker's sink starts now, then its first batch finds the fence moved
    expect(await stale).toEqual({ kind: 'lost' });
    parked.open();
    expect(await owned).toMatchObject({ kind: 'finished', state: 'SUCCEEDED', errorCode: null });
    const dto = await as((ctx) => imports.getFeedRun(ctx, run.id));
    expect(dto.counts).toMatchObject({ total: 600, valid: 600, failed: 0, withdrawn: 0 });
    const after = await listingsOf(c);
    expect([...after.values()].filter((l) => l.status === 'WITHDRAWN')).toHaveLength(0);
  });
});
