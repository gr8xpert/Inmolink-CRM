import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import {
  developmentAccess,
  developmentDocuments,
  developmentPhases,
  developments,
  developmentTranslations,
  priceLists,
  unitPriceHistories,
  units,
} from '@inmolink/db/schema/developments';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFounder, type Founder } from '../../../testing/factories';
import * as taxonomy from '../../taxonomy';

/**
 * Development tables and their sharing rules on the real database (S4-01). The generated isolation suite covers
 * every table's tenant isolation and that a PRIVATE_NETWORK development is hidden; this file covers what it
 * cannot seed: a development with its child rows, and `development_access` rows naming the reader.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];

let owner: Founder;
let allowed: Founder;
let stranger: Founder;
let unverified: Founder;
let ids: { location: string; type: string };

const as = <T>(f: Founder, fn: (tx: Tx) => Promise<T>) => withTenant({ agencyId: f.agencyId, userId: f.userId }, fn);
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('developments.test', fn);

/** A development of `owner` with one row in every child table (one shared and one internal document). */
async function seedDevelopment(over: Partial<typeof developments.$inferInsert> = {}): Promise<string> {
  const id = newId();
  const agencyId = owner.agencyId;
  await system(async (tx) => {
    await tx.insert(developments).values({
      id,
      agencyId,
      ref: code(`D${id.slice(-6)}`),
      name: 'Marbella Heights',
      locationId: ids.location,
      commissionBp: 500,
      ...over,
    });
    await tx.insert(developmentTranslations).values({
      developmentId: id,
      agencyId,
      locale: 'en',
      title: 'Marbella Heights',
      paymentTerms: '10 % on reservation',
      slug: 'marbella-heights',
    });
    const phaseId = newId();
    await tx.insert(developmentPhases).values({ id: phaseId, developmentId: id, agencyId, name: 'Phase 1' });
    const unitId = newId();
    await tx.insert(units).values({
      id: unitId,
      developmentId: id,
      agencyId,
      phaseId,
      ref: 'A-1-1',
      propertyTypeId: ids.type,
      bedrooms: 2,
      priceCents: 39_500_000,
    });
    const docId = newId();
    for (const [docKey, shared] of [
      [docId, true],
      [newId(), false],
    ] as const) {
      await tx.insert(developmentDocuments).values({
        id: docKey,
        developmentId: id,
        agencyId,
        kind: shared ? 'BROCHURE' : 'PRICE_LIST',
        fileName: shared ? 'brochure.pdf' : 'price-list.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
        sha256: (shared ? 'c' : 'd').repeat(64),
        storageKey: `developments/${agencyId}/${id}/${docKey}`,
        shared,
        uploadedBy: owner.userId,
      });
    }
    const priceListId = newId();
    await tx.insert(priceLists).values({
      id: priceListId,
      developmentId: id,
      agencyId,
      version: 1,
      effectiveFrom: '2026-10-01',
      sourceDocumentId: docId,
    });
    await tx
      .insert(unitPriceHistories)
      .values({ id: newId(), unitId, agencyId, priceListId, priceCents: 39_500_000, currency: 'EUR' });
  });
  return id;
}

const allow = (developmentId: string, f: Founder) =>
  system((tx) =>
    tx.insert(developmentAccess).values({ developmentId, agencyId: owner.agencyId, allowedAgencyId: f.agencyId }),
  );

/** How many rows of each table `f` reads for development `id`. */
async function visibleTo(f: Founder, id: string) {
  return as(f, async (tx) => {
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n;
    const n = sql<number>`count(*)::int`;
    return {
      development: await count(tx.select({ n }).from(developments).where(eq(developments.id, id))),
      translations: await count(
        tx.select({ n }).from(developmentTranslations).where(eq(developmentTranslations.developmentId, id)),
      ),
      phases: await count(tx.select({ n }).from(developmentPhases).where(eq(developmentPhases.developmentId, id))),
      units: await count(tx.select({ n }).from(units).where(eq(units.developmentId, id))),
      documents: await count(
        tx.select({ n }).from(developmentDocuments).where(eq(developmentDocuments.developmentId, id)),
      ),
      priceLists: await count(tx.select({ n }).from(priceLists).where(eq(priceLists.developmentId, id))),
      priceHistory: await count(
        tx
          .select({ n })
          .from(unitPriceHistories)
          .innerJoin(units, eq(units.id, unitPriceHistories.unitId))
          .where(eq(units.developmentId, id)),
      ),
    };
  });
}

const NETWORK_VIEW = {
  development: 1,
  translations: 1,
  phases: 1,
  units: 1,
  documents: 1,
  priceLists: 0,
  priceHistory: 0,
};
const NOTHING = { development: 0, translations: 0, phases: 0, units: 0, documents: 0, priceLists: 0, priceHistory: 0 };
const OWNER_VIEW = { ...NETWORK_VIEW, documents: 2, priceLists: 1, priceHistory: 1 };

beforeAll(async () => {
  await setupTestDb('worker');
  [owner, allowed, stranger, unverified] = await Promise.all([
    createFounder(),
    createFounder(),
    createFounder(),
    createFounder(),
  ]);
  for (const f of [owner, allowed, stranger]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('dc'),
      translations: tr(`Devland ${RUN}`, 'devland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('d-flats'),
      sort: 0,
      translations: tr(`Flats ${RUN}`, 'd-flats'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('d-apartment'),
      sort: 0,
      translations: tr(`Apartment ${RUN}`, 'd-apartment'),
    });
    return { location, type };
  });
}, 120_000);

afterAll(closeDb);

describe('development tables', () => {
  it('[S4-01] PRIVATE_NETWORK developments are invisible to non-allowed agencies', async () => {
    const id = await seedDevelopment({ access: 'PRIVATE_NETWORK' });
    expect(await visibleTo(allowed, id)).toEqual(NOTHING);
    expect(await visibleTo(stranger, id)).toEqual(NOTHING);

    await allow(id, allowed);
    await allow(id, unverified);
    expect(await visibleTo(allowed, id)).toEqual(NETWORK_VIEW);
    // Not named in development_access, or named but not verified: nothing.
    expect(await visibleTo(stranger, id)).toEqual(NOTHING);
    expect(await visibleTo(unverified, id)).toEqual(NOTHING);
    expect(await visibleTo(owner, id)).toEqual(OWNER_VIEW);
  });

  it('[S4-01] an allowed agency reads its own access row, never which other agencies are allowed', async () => {
    const id = await seedDevelopment({ access: 'PRIVATE_NETWORK' });
    await allow(id, allowed);
    await allow(id, stranger);
    const rowsFor = (f: Founder) =>
      as(f, (tx) =>
        tx
          .select({ agency: developmentAccess.allowedAgencyId })
          .from(developmentAccess)
          .where(eq(developmentAccess.developmentId, id)),
      );
    expect(await rowsFor(allowed)).toEqual([{ agency: allowed.agencyId }]);
    expect(await rowsFor(owner)).toHaveLength(2);
  });

  it('[S4-01] an allowed agency cannot write the development, its units or its access list', async () => {
    const id = await seedDevelopment({ access: 'PRIVATE_NETWORK' });
    await allow(id, allowed);
    const changed = await as(allowed, async (tx) => ({
      development: (await tx.update(developments).set({ name: 'Hijacked' }).where(eq(developments.id, id)).returning())
        .length,
      units: (await tx.update(units).set({ status: 'SOLD' }).where(eq(units.developmentId, id)).returning()).length,
      access: (await tx.delete(developmentAccess).where(eq(developmentAccess.developmentId, id)).returning()).length,
    }));
    expect(changed).toEqual({ development: 0, units: 0, access: 0 });
    await expect(
      as(allowed, (tx) =>
        tx
          .insert(developmentAccess)
          .values({ developmentId: id, agencyId: owner.agencyId, allowedAgencyId: stranger.agencyId }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('[S4-01] an OPEN development reaches every verified agency; price lists, price history and internal documents stay with the owner', async () => {
    const id = await seedDevelopment({ access: 'OPEN' });
    expect(await visibleTo(stranger, id)).toEqual(NETWORK_VIEW);
    expect(await visibleTo(unverified, id)).toEqual(NOTHING);
    expect(await visibleTo(owner, id)).toEqual(OWNER_VIEW);
    // Deleted: off the network.
    await system((tx) => tx.update(developments).set({ deletedAt: new Date() }).where(eq(developments.id, id)));
    expect(await visibleTo(stranger, id)).toEqual(NOTHING);
  });

  it('[S4-01] members read and append unit price history, never rewrite it', async () => {
    const id = await seedDevelopment();
    const [unit] = await system((tx) =>
      tx
        .select({ id: units.id })
        .from(units)
        .where(and(eq(units.developmentId, id), eq(units.ref, 'A-1-1'))),
    );
    for (const op of [
      (tx: Tx) => tx.delete(unitPriceHistories).where(eq(unitPriceHistories.unitId, unit?.id as string)),
      (tx: Tx) =>
        tx
          .update(unitPriceHistories)
          .set({ priceCents: 1 })
          .where(eq(unitPriceHistories.unitId, unit?.id as string)),
    ]) {
      await expect(as(owner, op)).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });
});
