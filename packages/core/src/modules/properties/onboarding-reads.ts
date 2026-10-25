import type { Tx } from '@inmolink/db';
import { properties } from '@inmolink/db/schema/properties';
import { and, inArray, isNull, min, ne, sql } from 'drizzle-orm';

/**
 * Onboarding backfill reads (S13-F26): for a page of agencies, the earliest time they had a listing, and the earliest
 * time (best known: the row's last update) a listing was on the network for every agency. One statement each,
 * grouped by agency (`properties_agency_*` indexes); a one-off maintenance read, not a request path.
 */
export async function earliestListingByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const rows = await tx
    .select({ agencyId: properties.agencyId, at: min(properties.createdAt) })
    .from(properties)
    .where(and(inArray(properties.agencyId, agencyIds), isNull(properties.deletedAt)))
    .groupBy(properties.agencyId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.agencyId, new Date(r.at)] as const] : [])));
}

/** Listings SHARED / PUBLIC with scope ALL and not hidden by the freshness sweep. */
export async function earliestSharedListingByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const rows = await tx
    .select({ agencyId: properties.agencyId, at: min(properties.updatedAt) })
    .from(properties)
    .where(
      and(
        inArray(properties.agencyId, agencyIds),
        isNull(properties.deletedAt),
        isNull(properties.networkHiddenAt),
        ne(properties.visibility, 'PRIVATE'),
        sql`${properties.shareScope} = 'ALL'`,
      ),
    )
    .groupBy(properties.agencyId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.agencyId, new Date(r.at)] as const] : [])));
}
