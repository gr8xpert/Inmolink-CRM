import type { Tx } from '@inmolink/db';
import { websiteSites } from '@inmolink/db/schema/websites';
import { inArray, min } from 'drizzle-orm';

/** Onboarding backfill (S13-F26): the earliest site per agency of a page (`website_sites_agency_created_idx`). */
export async function earliestSiteByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const rows = await tx
    .select({ agencyId: websiteSites.agencyId, at: min(websiteSites.createdAt) })
    .from(websiteSites)
    .where(inArray(websiteSites.agencyId, agencyIds))
    .groupBy(websiteSites.agencyId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.agencyId, new Date(r.at)] as const] : [])));
}
