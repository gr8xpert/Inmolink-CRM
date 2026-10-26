import type { Tx } from '@inmolink/db';
import { developments } from '@inmolink/db/schema/developments';
import { sql } from 'drizzle-orm';

/**
 * Onboarding backfill (S13-F26, plan in S14-F9): the earliest development per agency of a page. One statement, a
 * correlated `min()` per agency (`developments_agency_created_raw_idx`), no scan of the table.
 */
export async function earliestDevelopmentByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const res = await tx.execute<{ agency_id: string; at: Date | string | null }>(sql`
    select a.agency_id,
           (select min(d.created_at) from ${developments} d where d.agency_id = a.agency_id and d.deleted_at is null) as at
      from unnest(${sql`${sql.param(agencyIds)}::uuid[]`}) as a(agency_id)`);
  return new Map(res.rows.flatMap((r) => (r.at ? [[r.agency_id, new Date(r.at)] as const] : [])));
}
