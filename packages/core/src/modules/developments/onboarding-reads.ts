import type { Tx } from '@inmolink/db';
import { developments } from '@inmolink/db/schema/developments';
import { and, inArray, isNull, min } from 'drizzle-orm';

/** Onboarding backfill (S13-F26): the earliest development per agency of a page. One grouped statement. */
export async function earliestDevelopmentByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const rows = await tx
    .select({ agencyId: developments.agencyId, at: min(developments.createdAt) })
    .from(developments)
    .where(and(inArray(developments.agencyId, agencyIds), isNull(developments.deletedAt)))
    .groupBy(developments.agencyId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.agencyId, new Date(r.at)] as const] : [])));
}
