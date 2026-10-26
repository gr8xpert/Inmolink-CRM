/**
 * Legacy listing queries (S14-02): properties tables only, one statement per batch whatever its size (one bind parameter
 * per column). Runs in the load script's `withSystem()` transaction.
 */
import type { Tx } from '@inmolink/db';
import { properties, propertyFeatures } from '@inmolink/db/schema/properties';
import { sql } from 'drizzle-orm';

const array = (values: readonly unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;

/** New migrated listings: their legacy agent as owner and their legacy id. */
export async function setLegacyOrigin(
  tx: Tx,
  agencyId: string,
  rows: readonly { id: string; legacyId: string; ownerUserId: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    update ${properties} p set owner_user_id = v.owner_user_id, legacy_id = v.legacy_id
      from unnest(${array(
        rows.map((r) => r.id),
        'uuid',
      )}, ${array(
        rows.map((r) => r.legacyId),
        'text',
      )}, ${array(
        rows.map((r) => r.ownerUserId),
        'uuid',
      )}) as v(id, legacy_id, owner_user_id)
     where p.agency_id = ${agencyId} and p.id = v.id`);
}

/** S14-03: what a validation compares of a migrated listing (no text, no commission). */
export interface LegacyListingSnapshot {
  id: string;
  ref: string;
  status: string;
  transactionType: string;
  priceCents: number | null;
  currency: string;
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: string | null;
  plotM2: string | null;
  locationId: string | null;
  propertyTypeId: string | null;
  featureIds: string[];
}

/** These listings of the agency with their feature ids (S14-03 validation sample). One statement (PK). */
export async function legacySnapshots(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<LegacyListingSnapshot[]> {
  if (ids.length === 0) return [];
  const res = await tx.execute(sql`
    select p.id, p.ref, p.status, p.transaction_type as "transactionType", p.price_cents::float8 as "priceCents",
           p.currency, p.bedrooms, p.bathrooms, p.built_m2::text as "builtM2", p.plot_m2::text as "plotM2",
           p.location_id as "locationId", p.property_type_id as "propertyTypeId",
           coalesce((select array_agg(f.feature_id::text order by f.feature_id) from ${propertyFeatures} f
                      where f.property_id = p.id), '{}') as "featureIds"
      from ${properties} p
     where p.agency_id = ${agencyId} and p.id = any(${array(ids, 'uuid')}) and p.deleted_at is null`);
  return res.rows as unknown as LegacyListingSnapshot[];
}

/**
 * S14-04: a page of the agency's migrated listings (not deleted), in legacy id order after `after`. One statement,
 * keyset on `properties_agency_legacy_idx`.
 */
export async function migratedPage(
  tx: Tx,
  agencyId: string,
  after: string | null,
  limit: number,
): Promise<{ id: string; legacyId: string }[]> {
  const res = await tx.execute(sql`
    select p.id, p.legacy_id as "legacyId" from ${properties} p
     where p.agency_id = ${agencyId} and p.legacy_id is not null and p.deleted_at is null
       ${after === null ? sql`` : sql`and p.legacy_id > ${after}`}
     order by p.legacy_id limit ${limit}`);
  return res.rows as { id: string; legacyId: string }[];
}
