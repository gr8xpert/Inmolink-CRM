import type { Tx } from '@inmolink/db';
import { agencies, agencyVerificationRequests } from '@inmolink/db/schema/agencies';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * VERIFIED agencies of a page with when they were verified: the earliest approval, else (verified before requests
 * were recorded) the agency row's last update.
 */
export async function verifiedAtByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: agencies.id,
      at: sql<Date>`coalesce((select min(${agencyVerificationRequests.decidedAt}) from ${agencyVerificationRequests} where ${agencyVerificationRequests.agencyId} = ${agencies.id} and ${agencyVerificationRequests.status} = 'APPROVED'), ${agencies.updatedAt})`,
    })
    .from(agencies)
    .where(and(inArray(agencies.id, agencyIds), eq(agencies.status, 'VERIFIED')));
  return new Map(rows.map((r) => [r.id, new Date(r.at)]));
}
