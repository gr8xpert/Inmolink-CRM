import type { Tx } from '@inmolink/db';
import { agencyMembers, staffImpersonations } from '@inmolink/db/schema/identity';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

/**
 * `staff_impersonations` queries (S1-09, PATTERNS §5). Kept apart from `repo.ts` (size). Runs as
 * `app_staff` (start, end, the staff member's open session), `app_auth` (the access-token mint reads the
 * staff member's own session), `app_user` (the request ctx checks an impersonated call's session) and
 * `app_system` (`pnpm staff:revoke` ends a revoked staff member's session).
 */

export interface SessionRow {
  id: string;
  agencyId: string;
  targetUserId: string;
  startedAt: Date;
  expiresAt: Date;
}

const sessionColumns = {
  id: staffImpersonations.id,
  agencyId: staffImpersonations.agencyId,
  targetUserId: staffImpersonations.targetUserId,
  startedAt: staffImpersonations.startedAt,
  expiresAt: staffImpersonations.expiresAt,
};

/** Open and not expired (database time, like the guard and the window CHECK). */
const live = () => and(isNull(staffImpersonations.endedAt), gt(staffImpersonations.expiresAt, sql`now()`));

/** The member staff want to act as: name and whether they are active (staff predicate on `agency_members`). */
export async function findMember(
  tx: Tx,
  agencyId: string,
  userId: string,
): Promise<{ name: string; deactivatedAt: Date | null } | null> {
  const [row] = await tx
    .select({ name: agencyMembers.name, deactivatedAt: agencyMembers.deactivatedAt })
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)));
  return row ?? null;
}

/** Serialises session starts per staff member until the transaction ends (advisory, no table lock). */
export async function lockStaffSessions(tx: Tx, staffUserId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`staff_impersonation:${staffUserId}`}, 0))`);
}

/** Ends the staff member's open session (expired or not), so a new one can start (one open per staff). */
export async function endOpenSessions(tx: Tx, staffUserId: string): Promise<{ id: string; agencyId: string }[]> {
  return tx
    .update(staffImpersonations)
    .set({ endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(staffImpersonations.staffUserId, staffUserId), isNull(staffImpersonations.endedAt)))
    .returning({ id: staffImpersonations.id, agencyId: staffImpersonations.agencyId });
}

/** Starts a session now (database time: the 0026 guard compares with `now()`), `minutes` long. */
export async function insertSession(
  tx: Tx,
  row: { id: string; agencyId: string; staffUserId: string; targetUserId: string; reason: string; minutes: number },
): Promise<SessionRow> {
  const [inserted] = await tx
    .insert(staffImpersonations)
    .values({
      id: row.id,
      agencyId: row.agencyId,
      staffUserId: row.staffUserId,
      targetUserId: row.targetUserId,
      reason: row.reason,
      expiresAt: sql`now() + make_interval(mins => ${row.minutes}::int)`,
    })
    .returning(sessionColumns);
  if (!inserted) throw new Error('staff_impersonations: insert returned no row');
  return inserted;
}

/** Ends one open session of this staff member; null if it is not theirs or already ended. */
export async function endSession(
  tx: Tx,
  id: string,
  staffUserId: string,
): Promise<{ id: string; agencyId: string; targetUserId: string } | null> {
  const [row] = await tx
    .update(staffImpersonations)
    .set({ endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(staffImpersonations.id, id),
        eq(staffImpersonations.staffUserId, staffUserId),
        isNull(staffImpersonations.endedAt),
      ),
    )
    .returning({
      id: staffImpersonations.id,
      agencyId: staffImpersonations.agencyId,
      targetUserId: staffImpersonations.targetUserId,
    });
  return row ?? null;
}

/** The staff member's live session (`staff_impersonations_open_uq`), as app_staff or app_auth. */
export async function findLiveSession(tx: Tx, staffUserId: string, id?: string): Promise<SessionRow | null> {
  const [row] = await tx
    .select(sessionColumns)
    .from(staffImpersonations)
    .where(
      and(
        eq(staffImpersonations.staffUserId, staffUserId),
        id === undefined ? undefined : eq(staffImpersonations.id, id),
        live(),
      ),
    );
  return row ?? null;
}

export type MemberRole = (typeof agencyMembers.$inferSelect)['role'];

/**
 * The request ctx's one read (S2-F1, `withTenant`, app_user, own agency): the caller's active role in the
 * agency and, for an impersonated call, whether the session its token names is still open for this user and
 * agency (as the target member — the only row `user_select` shows it). `staff_user_id` is not readable by
 * app_user (S1-F10, ADR 0016); the signed token carries it from the row the mint read, and a session id
 * never changes hands (guard 0028). Always one row; `live` is true when no session is named.
 */
export async function findMemberAccess(
  tx: Tx,
  s: { agencyId: string; userId: string; impersonationId?: string },
): Promise<{ role: MemberRole | null; live: boolean }> {
  const m = agencyMembers;
  const i = staffImpersonations;
  const sessionLive = s.impersonationId
    ? sql`exists (select 1 from ${i} where ${i.id} = ${s.impersonationId} and ${i.agencyId} = ${s.agencyId}
                    and ${i.targetUserId} = ${s.userId} and ${live()})`
    : sql`true`;
  const res = await tx.execute<{ role: MemberRole | null; live: boolean }>(sql`
    select (select ${m.role} from ${m} where ${m.agencyId} = ${s.agencyId} and ${m.userId} = ${s.userId}
              and ${m.deactivatedAt} is null) as role,
           ${sessionLive} as live`);
  const row = res.rows[0];
  return { role: row?.role ?? null, live: row?.live === true };
}

export interface StaffAccessRow {
  id: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  status: 'ACTIVE' | 'ENDED' | 'EXPIRED';
  memberUserId: string;
  memberName: string;
  reason: string;
  /** S12-F20: `keysetStamp` of `started_at`, the raw keyset cursor. */
  atUs: string;
}

/**
 * The agency's record of staff access (S1-F9, `app_user`, own agency by RLS), newest first, keyset on
 * `(started_at, id)` over `staff_impersonations_agency_raw_idx` (S12-F20), with the member's name in the same query
 * (`agency_members` primary key). The staff member's id is not selected: staff identities stay with Inmolink.
 */
export async function listStaffAccess(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<StaffAccessRow[]> {
  const { cursor } = page;
  return tx
    .select({
      id: staffImpersonations.id,
      startedAt: staffImpersonations.startedAt,
      expiresAt: staffImpersonations.expiresAt,
      endedAt: staffImpersonations.endedAt,
      status: sql<StaffAccessRow['status']>`case when ${staffImpersonations.endedAt} is not null then 'ENDED'
        when ${staffImpersonations.expiresAt} <= now() then 'EXPIRED' else 'ACTIVE' end`,
      memberUserId: staffImpersonations.targetUserId,
      memberName: sql<string>`coalesce(${agencyMembers.name}, '')`,
      reason: staffImpersonations.reason,
      atUs: keysetStamp(staffImpersonations.startedAt),
    })
    .from(staffImpersonations)
    .leftJoin(
      agencyMembers,
      and(
        eq(agencyMembers.agencyId, staffImpersonations.agencyId),
        eq(agencyMembers.userId, staffImpersonations.targetUserId),
      ),
    )
    .where(
      and(
        eq(staffImpersonations.agencyId, agencyId),
        // the raw keyset (S12-F20): the cursor carries `started_at`'s microseconds (`atUs`)
        keysetAfterRaw(staffImpersonations.startedAt, staffImpersonations.id, cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(staffImpersonations.startedAt, staffImpersonations.id, 'desc'))
    .limit(page.limit + 1);
}

export interface OpenSessionRow {
  id: string;
  agencyId: string;
  staffUserId: string;
  targetUserId: string;
  startedAt: Date;
  expiresAt: Date;
}

/**
 * Every live session across staff (super admins, `app_staff` with the widened `staff_impersonations_open_uq`
 * read, S1-F9): at most one per staff member, so the list is as long as the staff team is — bounded.
 */
export async function listLiveSessions(tx: Tx, limit: number): Promise<OpenSessionRow[]> {
  return tx
    .select({
      id: staffImpersonations.id,
      agencyId: staffImpersonations.agencyId,
      staffUserId: staffImpersonations.staffUserId,
      targetUserId: staffImpersonations.targetUserId,
      startedAt: staffImpersonations.startedAt,
      expiresAt: staffImpersonations.expiresAt,
    })
    .from(staffImpersonations)
    .where(live())
    .orderBy(desc(staffImpersonations.startedAt), desc(staffImpersonations.id))
    .limit(limit);
}

/** Ends any open session by id (super admin, S1-F9); null if it is already ended. */
export async function endAnySession(
  tx: Tx,
  id: string,
): Promise<{ id: string; agencyId: string; staffUserId: string; targetUserId: string } | null> {
  const [row] = await tx
    .update(staffImpersonations)
    .set({ endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(staffImpersonations.id, id), isNull(staffImpersonations.endedAt)))
    .returning({
      id: staffImpersonations.id,
      agencyId: staffImpersonations.agencyId,
      staffUserId: staffImpersonations.staffUserId,
      targetUserId: staffImpersonations.targetUserId,
    });
  return row ?? null;
}
