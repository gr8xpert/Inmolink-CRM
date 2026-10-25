import type { Tx } from '@inmolink/db';
import { agencyMembers, users } from '@inmolink/db/schema/identity';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/**
 * Realtime session queries (S12-F10, PATTERNS §5), kept apart from `repo.ts`. Worker-facing (`app_system`): chat
 * fan-out keeps only active members; a session revocation reaches every agency the user belongs to.
 */

/** The (agency, user) pairs among `pairs` that are active members (any role), as `agencyId:userId` keys. One statement. */
export async function activeMembersAcross(
  tx: Tx,
  pairs: readonly { agencyId: string; userId: string }[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await tx
    .select({ agencyId: agencyMembers.agencyId, userId: agencyMembers.userId })
    .from(agencyMembers)
    .where(
      and(
        inArray(agencyMembers.agencyId, [...new Set(pairs.map((p) => p.agencyId))]),
        inArray(agencyMembers.userId, [...new Set(pairs.map((p) => p.userId))]),
        isNull(agencyMembers.deactivatedAt),
      ),
    );
  const wanted = new Set(pairs.map((p) => `${p.agencyId}:${p.userId}`));
  return new Set(rows.map((r) => `${r.agencyId}:${r.userId}`).filter((k) => wanted.has(k)));
}

/** The user's current `session_version` and the agencies they belong to (deactivated memberships too), ≤ `max`. */
export async function sessionScope(
  tx: Tx,
  userId: string,
  max: number,
): Promise<{ sessionVersion: number; agencyIds: string[] } | null> {
  const [user] = await tx.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, userId));
  if (!user) return null;
  const rows = await tx
    .select({ agencyId: agencyMembers.agencyId })
    .from(agencyMembers)
    .where(eq(agencyMembers.userId, userId))
    .limit(max);
  return { sessionVersion: user.sessionVersion, agencyIds: rows.map((r) => r.agencyId) };
}

/** When the member was deactivated (database time), or null (active again, or no such member). Primary-key lookup. */
export async function memberDeactivatedAt(tx: Tx, agencyId: string, userId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ deactivatedAt: agencyMembers.deactivatedAt })
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)));
  return row?.deactivatedAt ?? null;
}
