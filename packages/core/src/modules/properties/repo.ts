/**
 * properties queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/properties` — other modules' tables fail `pnpm check:boundaries`.
 * Runs as `app_user` under `withTenant`: RLS shows the agency's own listings plus the network's shared ones.
 */
import type { Tx } from '@inmolink/db';
import {
  properties,
  propertyFeatures,
  propertyPriceHistories,
  propertyPrivates,
  propertyStatusHistories,
  propertyTranslations,
} from '@inmolink/db/schema/properties';
import { and, asc, eq, gte, isNull, notInArray, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

export type ListingRow = typeof properties.$inferSelect;
export type ListingInsert = typeof properties.$inferInsert;
export type PrivatesRow = typeof propertyPrivates.$inferSelect;
export type PrivatesPatch = Partial<Omit<typeof propertyPrivates.$inferInsert, 'propertyId' | 'agencyId'>>;
export type ListingStatus = ListingRow['status'];

export async function insertListing(tx: Tx, row: ListingInsert): Promise<ListingRow> {
  const [created] = await tx.insert(properties).values(row).returning();
  return created as ListingRow;
}

export async function insertPrivates(tx: Tx, row: typeof propertyPrivates.$inferInsert): Promise<PrivatesRow> {
  const [created] = await tx.insert(propertyPrivates).values(row).returning();
  return created as PrivatesRow;
}

/** A listing visible to the caller (own or shared with it, RLS), deleted ones included; null if none. */
export async function getListing(tx: Tx, id: string): Promise<ListingRow | null> {
  const [row] = await tx.select().from(properties).where(eq(properties.id, id));
  return row ?? null;
}

/** The caller's own listing, row-locked for a change (other agencies' rows are never locked or written). */
export async function getOwnForUpdate(tx: Tx, agencyId: string, id: string): Promise<ListingRow | null> {
  const [row] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.agencyId, agencyId)))
    .for('update');
  return row ?? null;
}

export async function getPrivates(tx: Tx, propertyId: string): Promise<PrivatesRow | null> {
  const [row] = await tx.select().from(propertyPrivates).where(eq(propertyPrivates.propertyId, propertyId));
  return row ?? null;
}

/** Optimistic update: null when `version` is stale. Bumps `version` and `updated_at`. */
export async function updateWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<ListingInsert>,
): Promise<ListingRow | null> {
  const [row] = await tx
    .update(properties)
    .set({ ...patch, version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(properties.id, id), eq(properties.version, version)))
    .returning();
  return row ?? null;
}

export async function updatePrivates(tx: Tx, propertyId: string, patch: PrivatesPatch): Promise<PrivatesRow | null> {
  const [row] = await tx
    .update(propertyPrivates)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(propertyPrivates.propertyId, propertyId))
    .returning();
  return row ?? null;
}

export async function insertPriceHistory(
  tx: Tx,
  row: {
    id: string;
    propertyId: string;
    agencyId: string;
    previousPriceCents: number | null;
    priceCents: number | null;
    currency: string;
    changedByUserId: string | null;
  },
): Promise<void> {
  await tx.insert(propertyPriceHistories).values(row);
}

export async function insertStatusHistory(
  tx: Tx,
  row: {
    id: string;
    propertyId: string;
    agencyId: string;
    fromStatus: ListingStatus | null;
    toStatus: ListingStatus;
    changedByUserId: string | null;
  },
): Promise<void> {
  await tx.insert(propertyStatusHistories).values(row);
}

const summaryColumns = {
  id: properties.id,
  ref: properties.ref,
  ownerUserId: properties.ownerUserId,
  status: properties.status,
  visibility: properties.visibility,
  transactionType: properties.transactionType,
  priceCents: properties.priceCents,
  currency: properties.currency,
  bedrooms: properties.bedrooms,
  propertyTypeId: properties.propertyTypeId,
  locationId: properties.locationId,
  createdAt: properties.createdAt,
  deletedAt: properties.deletedAt,
};
export type ListingSummaryRow = { [K in keyof typeof summaryColumns]: ListingRow[K] };

/**
 * The agency's own listings, newest first, keyset on `(created_at, id)` over `properties_agency_created_idx`.
 * `deletedSince`: the listings deleted since then (the restorable ones) instead of the live ones; `ownerUserId`:
 * one member's (`properties_agency_owner_created_idx`).
 */
export async function listOwn(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor; status?: ListingStatus; ownerUserId?: string; deletedSince?: Date },
): Promise<ListingSummaryRow[]> {
  return tx
    .select(summaryColumns)
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, agencyId),
        q.deletedSince ? gte(properties.deletedAt, q.deletedSince) : isNull(properties.deletedAt),
        q.status ? eq(properties.status, q.status) : undefined,
        q.ownerUserId ? eq(properties.ownerUserId, q.ownerUserId) : undefined,
        keysetAfter(properties.createdAt, properties.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(properties.createdAt, properties.id, 'desc'))
    .limit(q.limit + 1);
}

// ---- Content (S3-05): translations and features -------------------------------------------------------------

export type TranslationRow = typeof propertyTranslations.$inferSelect;
export type TranslationInsert = typeof propertyTranslations.$inferInsert;

const translationColumns = {
  locale: propertyTranslations.locale,
  title: propertyTranslations.title,
  description: propertyTranslations.description,
  slug: propertyTranslations.slug,
  metaTitle: propertyTranslations.metaTitle,
  metaDescription: propertyTranslations.metaDescription,
  origin: propertyTranslations.origin,
  locked: propertyTranslations.locked,
  updatedAt: propertyTranslations.updatedAt,
};
export type TranslationView = { [K in keyof typeof translationColumns]: TranslationRow[K] };

/** A listing's translations by locale (primary key `(property_id, locale)`). */
export async function listTranslations(tx: Tx, propertyId: string): Promise<TranslationView[]> {
  return tx
    .select(translationColumns)
    .from(propertyTranslations)
    .where(eq(propertyTranslations.propertyId, propertyId))
    .orderBy(asc(propertyTranslations.locale));
}

/** Inserts or replaces one locale's text. */
export async function upsertTranslation(tx: Tx, row: TranslationInsert): Promise<TranslationView> {
  const { propertyId: _p, agencyId: _a, locale: _l, ...changes } = row;
  const [saved] = await tx
    .insert(propertyTranslations)
    .values(row)
    .onConflictDoUpdate({
      target: [propertyTranslations.propertyId, propertyTranslations.locale],
      set: { ...changes, updatedAt: sql`now()` },
    })
    .returning(translationColumns);
  return saved as TranslationView;
}

/** True when a row was deleted. */
export async function deleteTranslation(tx: Tx, propertyId: string, locale: string): Promise<boolean> {
  const rows = await tx
    .delete(propertyTranslations)
    .where(and(eq(propertyTranslations.propertyId, propertyId), eq(propertyTranslations.locale, locale)))
    .returning({ locale: propertyTranslations.locale });
  return rows.length > 0;
}

/** A listing's feature ids (primary key `(property_id, feature_id)`). */
export async function listFeatureIds(tx: Tx, propertyId: string): Promise<string[]> {
  const rows = await tx
    .select({ featureId: propertyFeatures.featureId })
    .from(propertyFeatures)
    .where(eq(propertyFeatures.propertyId, propertyId))
    .orderBy(asc(propertyFeatures.featureId));
  return rows.map((r) => r.featureId);
}

/** Replaces the listing's features with `featureIds`: one delete of the dropped, one insert of the new. */
export async function replaceFeatures(
  tx: Tx,
  ref: { propertyId: string; agencyId: string },
  featureIds: readonly string[],
): Promise<void> {
  await tx
    .delete(propertyFeatures)
    .where(
      and(
        eq(propertyFeatures.propertyId, ref.propertyId),
        featureIds.length > 0 ? notInArray(propertyFeatures.featureId, [...featureIds]) : undefined,
      ),
    );
  if (featureIds.length === 0) return;
  await tx
    .insert(propertyFeatures)
    .values(featureIds.map((featureId) => ({ ...ref, featureId })))
    .onConflictDoNothing();
}

/** Bumps the listing's `version` (content changes count as listing changes); null when `version` is stale. */
export async function bumpVersion(tx: Tx, id: string, version: number): Promise<number | null> {
  const [row] = await tx
    .update(properties)
    .set({ version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(properties.id, id), eq(properties.version, version)))
    .returning({ version: properties.version });
  return row?.version ?? null;
}
