import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import {
  properties,
  propertyFeatures,
  propertyPriceHistories,
  propertyPrivates,
  propertyStatusHistories,
  propertyTranslations,
} from '@inmolink/db/schema/properties';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';

/**
 * Listing tables and their sharing rules on the real database (S3-01). The generated isolation suite covers
 * every table's tenant isolation; this file covers what it cannot seed: a listing with its child rows, read
 * by another verified agency.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

let owner: Founder;
let reader: Founder;
let unverified: Founder;
let stranger: Founder;
let ids: { location: string; type: string; feature: string };

const as = <T>(f: Founder, fn: (tx: Tx) => Promise<T>) => withTenant({ agencyId: f.agencyId, userId: f.userId }, fn);
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('properties.test', fn);

/** A listing of `owner` with one row in every child table. */
async function seedListing(over: Partial<typeof properties.$inferInsert> = {}): Promise<string> {
  const id = newId();
  const agencyId = owner.agencyId;
  await system(async (tx) => {
    await tx.insert(properties).values({
      id,
      agencyId,
      ownerUserId: owner.userId,
      ref: code(`R${id.slice(-6)}`),
      status: 'ACTIVE',
      visibility: 'SHARED',
      priceCents: 45_000_000,
      commissionBp: 500,
      splitBp: 5000,
      propertyTypeId: ids.type,
      locationId: ids.location,
      ...over,
    });
    await tx.insert(propertyPrivates).values({
      propertyId: id,
      agencyId,
      cadastralRef: '1234567AB1234C0001XY',
      exactLat: '36.510071',
      exactLng: '-4.882447',
    });
    await tx
      .insert(propertyTranslations)
      .values({ propertyId: id, agencyId, locale: 'en', title: 'Sea view villa', slug: 'sea-view-villa' });
    await tx.insert(propertyFeatures).values({ propertyId: id, agencyId, featureId: ids.feature });
    // Media rows belong to the media module (S3-03): written with SQL, not its schema. The document is a nota
    // simple (seller names and cadastral data), never shared — its own STRICT table since S3-F5.
    await tx.execute(sql`insert into property_media (id, property_id, agency_id, sha256, position, is_cover, kind)
      values (${newId()}, ${id}, ${agencyId}, ${'a'.repeat(64)}, 0, true, 'IMAGE')`);
    await tx.execute(sql`insert into listing_documents
        (id, agency_id, property_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
      values (${newId()}, ${agencyId}, ${id}, 'nota-simple.pdf', 'application/pdf', 1, ${'b'.repeat(64)},
              ${`documents/${agencyId}/${id}/${newId()}`}, ${newId()})`);
    await tx
      .insert(propertyPriceHistories)
      .values({ id: newId(), propertyId: id, agencyId, priceCents: 45_000_000, currency: 'EUR' });
    await tx.insert(propertyStatusHistories).values({ id: newId(), propertyId: id, agencyId, toStatus: 'ACTIVE' });
  });
  return id;
}

/** How many rows of each table `f` reads for listing `id`. */
async function visibleTo(f: Founder, id: string) {
  return as(f, async (tx) => {
    const n = async (table: typeof propertyPrivates | typeof propertyTranslations | typeof propertyFeatures) =>
      (await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.propertyId, id)))[0]?.n;
    const m = async (table: typeof propertyPriceHistories | typeof propertyStatusHistories) =>
      (await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.propertyId, id)))[0]?.n;
    return {
      listing: (await tx.select({ n: sql<number>`count(*)::int` }).from(properties).where(eq(properties.id, id)))[0]?.n,
      privates: await n(propertyPrivates),
      translations: await n(propertyTranslations),
      features: await n(propertyFeatures),
      media: Number(
        (
          await tx.execute(sql`select (select count(*) from property_media where property_id = ${id})
                                    + (select count(*) from listing_documents where property_id = ${id}) as n`)
        ).rows[0]?.n,
      ),
      priceHistory: await m(propertyPriceHistories),
      statusHistory: await m(propertyStatusHistories),
    };
  });
}

const SHARED_VIEW = {
  listing: 1,
  privates: 0,
  translations: 1,
  features: 1,
  media: 1,
  priceHistory: 0,
  statusHistory: 0,
};
const NOTHING = { ...SHARED_VIEW, listing: 0, translations: 0, features: 0, media: 0 };

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, reader, unverified, stranger] = await Promise.all([
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
  ]);
  for (const f of [owner, reader, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('pc'),
      translations: tr(`Propland ${RUN}`, 'propland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('p-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'p-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('p-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'p-villa'),
    });
    const fg = await taxonomy.createFeatureGroup(tx, {
      key: code('p-outdoor'),
      sort: 0,
      translations: tr(`Outdoor ${RUN}`, 'p-outdoor'),
    });
    const feature = await taxonomy.createFeature(tx, {
      groupId: fg,
      key: code('p-pool'),
      icon: 'waves',
      sort: 0,
      translations: tr(`Pool ${RUN}`, 'p-pool'),
    });
    return { location, type, feature };
  });
}, 120_000);

afterAll(closeDb);

describe('listing tables', () => {
  it('[S3-01] another tenant can read a SHARED ACTIVE listing but never its property_privates row', async () => {
    const id = await seedListing();
    expect(await visibleTo(reader, id)).toEqual(SHARED_VIEW);
    // The owner reads everything.
    // The owner reads everything, documents included.
    expect(await visibleTo(owner, id)).toEqual({
      ...SHARED_VIEW,
      privates: 1,
      media: 2,
      priceHistory: 1,
      statusHistory: 1,
    });
  });

  it('[S3-01] a PREFERRED listing and its child rows reach only the agencies the owner prefers', async () => {
    const id = await seedListing({ shareScope: 'PREFERRED' });
    expect(await visibleTo(reader, id)).toEqual(NOTHING);
    await system((tx) =>
      tx.execute(
        sql`insert into preferred_agencies (agency_id, preferred_agency_id) values (${owner.agencyId}, ${reader.agencyId})`,
      ),
    );
    try {
      expect(await visibleTo(reader, id)).toEqual(SHARED_VIEW);
      expect(await visibleTo(stranger, id)).toEqual(NOTHING);
    } finally {
      await system((tx) =>
        tx.execute(
          sql`delete from preferred_agencies where agency_id = ${owner.agencyId} and preferred_agency_id = ${reader.agencyId}`,
        ),
      );
    }
  });

  it('[S3-01] members read and append price and status history, never rewrite it', async () => {
    const id = await seedListing();
    for (const table of [propertyPriceHistories, propertyStatusHistories]) {
      await expect(as(owner, (tx) => tx.delete(table).where(eq(table.propertyId, id)))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    }
    await expect(
      as(owner, (tx) =>
        tx.update(propertyStatusHistories).set({ toStatus: 'SOLD' }).where(eq(propertyStatusHistories.propertyId, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('[S3-01] a PRIVATE, DRAFT or deleted listing and its child rows stay with the owner', async () => {
    for (const over of [{ visibility: 'PRIVATE' as const }, { status: 'DRAFT' as const }, { deletedAt: new Date() }]) {
      const id = await seedListing(over);
      expect(await visibleTo(reader, id), JSON.stringify(over)).toEqual(NOTHING);
    }
  });

  it('[S3-01] an unverified agency reads nothing of a shared listing; a suspended owner leaves the network', async () => {
    const id = await seedListing();
    expect(await visibleTo(unverified, id)).toEqual(NOTHING);
    await setAgencyStatus(owner.agencyId, 'SUSPENDED');
    try {
      expect(await visibleTo(reader, id)).toEqual(NOTHING);
    } finally {
      await setAgencyStatus(owner.agencyId, 'VERIFIED');
    }
    expect(await visibleTo(reader, id)).toEqual(SHARED_VIEW);
  });

  it("[S3-01] an agency cannot hang rows on another agency's listing (composite foreign key)", async () => {
    const id = await seedListing();
    const attempt = as(reader, (tx) =>
      tx
        .insert(propertyTranslations)
        .values({ propertyId: id, agencyId: reader.agencyId, locale: 'es', title: 'Mine now', slug: 'mine-now' }),
    );
    await expect(attempt).rejects.toMatchObject({ cause: { code: '23503' } });
    // Nor write the listing itself (NETWORK_READ is read-only for others).
    const update = await as(reader, (tx) =>
      tx.update(properties).set({ priceCents: 1 }).where(eq(properties.id, id)).returning({ id: properties.id }),
    );
    expect(update).toEqual([]);
  });

  it('[S3-01] commission, split, coordinates and energy rating are checked by the database', async () => {
    for (const over of [
      { commissionBp: 500, commissionFixedCents: 100_000 },
      { splitBp: 10_001 },
      { commissionBp: 0 },
      { lat: '36.5' },
      { pricePeriod: 'MONTH' as const },
    ]) {
      await expect(seedListing(over), JSON.stringify(over)).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });

  it('[S7-F15] properties_costs_ck is validated after the migrations, and a negative fee is still refused', async () => {
    const rows = await withSystem('test.s7-f15', (tx) =>
      tx.execute<{ convalidated: boolean }>(
        sql`select convalidated from pg_constraint where conname = 'properties_costs_ck' and conrelid = 'properties'::regclass`,
      ),
    );
    expect(rows.rows).toEqual([{ convalidated: true }]);
    for (const over of [
      { priceToCents: -1 },
      { communityFeeMonthCents: -1 },
      { ibiYearCents: -1 },
      { garbageTaxYearCents: -1 },
    ]) {
      await expect(seedListing(over), JSON.stringify(over)).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });
});
