import type { Tx } from '@inmolink/db';
import { properties } from '@inmolink/db/schema/properties';
import { sql } from 'drizzle-orm';

/**
 * Onboarding backfill reads (S13-F26, plans in S14-F9): for a page of agencies, the earliest time they had a listing,
 * and the earliest time (best known: the row's last update) a listing was on the network. One statement each, a
 * correlated `min()` per agency of the page so every agency is a bounded index probe
 * (`properties_agency_created_raw_idx` / `properties_agency_updated_raw_idx`) instead of the grouped scan the planner
 * turns into a Seq Scan once a page covers a fifth of the table. A one-off maintenance read, not a request path.
 */
const idArray = (ids: readonly string[]) => sql`${sql.param(ids)}::uuid[]`;

type EarliestRow = { agency_id: string; at: Date | string | null };

function toMap(rows: readonly EarliestRow[]): Map<string, Date> {
  return new Map(rows.flatMap((r) => (r.at ? [[r.agency_id, new Date(r.at)] as const] : [])));
}

export async function earliestListingByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const res = await tx.execute<EarliestRow>(sql`
    select a.agency_id,
           (select min(p.created_at) from ${properties} p where p.agency_id = a.agency_id and p.deleted_at is null) as at
      from unnest(${idArray(agencyIds)}) as a(agency_id)`);
  return toMap(res.rows);
}

/** Listings SHARED / PUBLIC with scope ALL and not hidden by the freshness sweep. */
export async function earliestSharedListingByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const res = await tx.execute<EarliestRow>(sql`
    select a.agency_id,
           (select min(p.updated_at) from ${properties} p
             where p.agency_id = a.agency_id and p.deleted_at is null and p.network_hidden_at is null
               and p.visibility <> 'PRIVATE' and p.share_scope = 'ALL') as at
      from unnest(${idArray(agencyIds)}) as a(agency_id)`);
  return toMap(res.rows);
}
