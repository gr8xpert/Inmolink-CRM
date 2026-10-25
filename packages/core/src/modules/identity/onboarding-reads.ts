import type { Tx } from '@inmolink/db';
import { agencyInvites, agencyMembers } from '@inmolink/db/schema/identity';
import { inArray, min, sql } from 'drizzle-orm';

/**
 * Onboarding backfill (S13-F26): when each agency of a page first invited someone — the earlier of its first invite
 * and its second member joining. Two grouped statements.
 */
export async function earliestTeamInviteByAgency(tx: Tx, agencyIds: string[]): Promise<Map<string, Date>> {
  if (agencyIds.length === 0) return new Map();
  const invites = await tx
    .select({ agencyId: agencyInvites.agencyId, at: min(agencyInvites.createdAt) })
    .from(agencyInvites)
    .where(inArray(agencyInvites.agencyId, agencyIds))
    .groupBy(agencyInvites.agencyId);
  const second = await tx
    .select({
      agencyId: agencyMembers.agencyId,
      at: sql<Date | null>`(array_agg(${agencyMembers.createdAt} order by ${agencyMembers.createdAt}))[2]`,
    })
    .from(agencyMembers)
    .where(inArray(agencyMembers.agencyId, agencyIds))
    .groupBy(agencyMembers.agencyId);
  const out = new Map<string, Date>();
  for (const r of [...invites, ...second]) {
    if (!r.at) continue;
    const at = new Date(r.at);
    const known = out.get(r.agencyId);
    if (!known || at < known) out.set(r.agencyId, at);
  }
  return out;
}
