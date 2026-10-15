/**
 * properties queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/properties` — other modules' tables fail `pnpm check:boundaries`.
 * Runs as `app_user` under `withTenant`: RLS shows the agency's own listings plus the network's shared ones.
 */
import type { Tx } from '@inmolink/db';
import {
  properties,
  propertyPriceHistories,
  propertyPrivates,
  propertyStatusHistories,
} from '@inmolink/db/schema/properties';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
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
