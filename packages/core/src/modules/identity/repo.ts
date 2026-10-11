import type { Tx } from '@inmolink/db';
import { agencyInvites, agencyMembers, authTokens, staffUsers, users } from '@inmolink/db/schema/identity';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';

/**
 * Identity tables only (PATTERNS §5). Runs as `app_auth` in auth flows (`withAuth`), as `app_user`
 * under `withTenant` for team management, and as `app_system` in the email jobs. Time comparisons take
 * `now` from the platform clock, so expiry is testable with a fake clock.
 */

export type TokenKind = 'EMAIL_VERIFY' | 'PASSWORD_RESET';

const credentialColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  locale: users.locale,
  status: users.status,
  emailVerifiedAt: users.emailVerifiedAt,
  sessionVersion: users.sessionVersion,
  passwordHash: users.passwordHash,
};

/**
 * Inserts a user unless the email is taken. Returns the new id, or null when it already existed.
 * `emailVerifiedAt` is set only when the caller proved the email (an invite link).
 */
export async function insertUserIfAbsent(
  tx: Tx,
  row: { id: string; email: string; passwordHash: string; name: string; locale: string; emailVerifiedAt?: Date },
): Promise<string | null> {
  const [inserted] = await tx
    .insert(users)
    .values(row)
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  return inserted?.id ?? null;
}

/** A repeated sign-up: the existing account, locked so a concurrent confirmation waits for this one. */
export async function findSignupState(tx: Tx, email: string) {
  const [row] = await tx
    .select({ id: users.id, status: users.status, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.email, email))
    .for('update');
  return row ?? null;
}

/**
 * A repeated sign-up for an email that was never confirmed takes over that pending account (new
 * password, name, locale): whoever controls the inbox decides which password the account gets. The
 * caller locked the row (`findSignupState`) and checked that its agency may still be replaced.
 */
export async function replaceUnverifiedSignup(
  tx: Tx,
  id: string,
  row: { passwordHash: string; name: string; locale: string },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ ...row, updatedAt: now })
    .where(and(eq(users.id, id), isNull(users.emailVerifiedAt), eq(users.status, 'ACTIVE')))
    .returning({ id: users.id });
  return rows.length === 1;
}

export async function findUserIdByEmail(tx: Tx, email: string): Promise<{ id: string; status: string } | null> {
  const [row] = await tx.select({ id: users.id, status: users.status }).from(users).where(eq(users.email, email));
  return row ?? null;
}

/** For the credential check only: the one query that reads `password_hash`. */
export async function findCredentialsByEmail(tx: Tx, email: string) {
  const [row] = await tx.select(credentialColumns).from(users).where(eq(users.email, email));
  return row ?? null;
}

export async function findUserForToken(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      status: users.status,
      emailVerifiedAt: users.emailVerifiedAt,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, id));
  return row ?? null;
}

export async function findUserForEmail(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      email: users.email,
      name: users.name,
      locale: users.locale,
      status: users.status,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, id));
  return row ?? null;
}

export async function recordLogin(tx: Tx, id: string, now: Date, rehash?: { from: string; to: string }) {
  await tx
    .update(users)
    .set({
      lastLoginAt: now,
      ...(rehash ? { passwordHash: rehash.to, updatedAt: now } : {}),
    })
    // A concurrent password reset wins over an opportunistic rehash.
    .where(and(eq(users.id, id), rehash ? eq(users.passwordHash, rehash.from) : undefined));
}

/** Only if the password is still the one the caller proved (a concurrent re-sign-up wins). */
export async function markEmailVerified(tx: Tx, id: string, passwordHash: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now})`, updatedAt: now })
    .where(and(eq(users.id, id), eq(users.status, 'ACTIVE'), eq(users.passwordHash, passwordHash)))
    .returning({ id: users.id });
  return rows.length === 1;
}

/** The owner of a live (unused, unexpired) token, without consuming it. */
export async function findTokenOwner(tx: Tx, tokenHash: string, kind: TokenKind, now: Date) {
  const [row] = await tx
    .select({ userId: authTokens.userId, passwordHash: users.passwordHash })
    .from(authTokens)
    .innerJoin(users, eq(users.id, authTokens.userId))
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.kind, kind),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    );
  return row ?? null;
}

/** New password, sessions revoked (`session_version + 1`); a reset link also proves the email. */
export async function setPassword(tx: Tx, id: string, passwordHash: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({
      passwordHash,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now})`,
      updatedAt: now,
    })
    .where(and(eq(users.id, id), eq(users.status, 'ACTIVE')))
    .returning({ id: users.id });
  return rows.length === 1;
}

/** Retires the user's unused tokens of `kind`, then stores the new one: only the latest link works. */
export async function replaceToken(
  tx: Tx,
  row: { id: string; userId: string; kind: TokenKind; tokenHash: string; expiresAt: Date },
  now: Date,
): Promise<void> {
  await tx
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.userId, row.userId), eq(authTokens.kind, row.kind), isNull(authTokens.usedAt)));
  await tx.insert(authTokens).values(row);
}

/**
 * Single use: marks the token used and returns its user in one statement, so two concurrent
 * requests with the same link cannot both succeed. Unknown, used and expired tokens return null.
 */
export async function consumeToken(tx: Tx, tokenHash: string, kind: TokenKind, now: Date): Promise<string | null> {
  const [row] = await tx
    .update(authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.kind, kind),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: authTokens.userId });
  return row?.userId ?? null;
}

export type MemberRole = (typeof agencyMembers.$inferSelect)['role'];

/** A new membership: the founder at sign-up, or an invitee accepting (app_auth, scope pinned to both). */
/**
 * `createdAt` comes from the platform clock (millisecond precision, like the keyset cursor), not the
 * database default (microseconds), so a page boundary on this row compares equal.
 */
export async function insertMember(
  tx: Tx,
  row: { agencyId: string; userId: string; role: MemberRole; name: string; email: string; createdAt: Date },
): Promise<void> {
  await tx.insert(agencyMembers).values({ ...row, updatedAt: row.createdAt });
}

/** The user's agency, role and deactivation; one membership per user. */
export async function findMembership(
  tx: Tx,
  userId: string,
): Promise<{ agencyId: string; role: MemberRole; deactivatedAt: Date | null } | null> {
  const [row] = await tx
    .select({ agencyId: agencyMembers.agencyId, role: agencyMembers.role, deactivatedAt: agencyMembers.deactivatedAt })
    .from(agencyMembers)
    .where(eq(agencyMembers.userId, userId));
  return row ?? null;
}

/** The user's role in `agencyId` (primary-key lookup), or null if not an active member there. */
export async function findMemberRole(tx: Tx, agencyId: string, userId: string): Promise<MemberRole | null> {
  const [row] = await tx
    .select({ role: agencyMembers.role })
    .from(agencyMembers)
    .where(
      and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId), isNull(agencyMembers.deactivatedAt)),
    );
  return row?.role ?? null;
}

/** A repeated sign-up: the founder's role and name follow the new details. */
export async function updateFounderMember(
  tx: Tx,
  agencyId: string,
  userId: string,
  patch: { role: MemberRole; name: string },
  now: Date,
): Promise<void> {
  await tx
    .update(agencyMembers)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)));
}

const memberColumns = {
  userId: agencyMembers.userId,
  name: agencyMembers.name,
  email: agencyMembers.email,
  role: agencyMembers.role,
  deactivatedAt: agencyMembers.deactivatedAt,
  createdAt: agencyMembers.createdAt,
};

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  deactivatedAt: Date | null;
  createdAt: Date;
}

/** Team list, oldest first (the founder leads): keyset on `(created_at, user_id)`. */
export async function listMembers(
  tx: Tx,
  agencyId: string,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<MemberRow[]> {
  return tx
    .select(memberColumns)
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, agencyId),
        q.cursor
          ? or(
              gt(agencyMembers.createdAt, q.cursor.at),
              and(eq(agencyMembers.createdAt, q.cursor.at), gt(agencyMembers.userId, q.cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(agencyMembers.createdAt), asc(agencyMembers.userId))
    .limit(q.limit + 1);
}

/**
 * Locks the caller's and the target's member rows, in user-id order so two admins acting on each other
 * wait instead of deadlocking, and returns them as they are now.
 */
export async function lockMembers(tx: Tx, agencyId: string, userIds: string[]): Promise<MemberRow[]> {
  return tx
    .select(memberColumns)
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), inArray(agencyMembers.userId, userIds)))
    .orderBy(asc(agencyMembers.userId))
    .for('update');
}

export async function updateMember(
  tx: Tx,
  agencyId: string,
  userId: string,
  patch: { role?: MemberRole; deactivatedAt?: Date },
  now: Date,
): Promise<MemberRow | null> {
  const [row] = await tx
    .update(agencyMembers)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)))
    .returning(memberColumns);
  return row ?? null;
}

/** Whether the email already belongs to a member of the agency (active or not). */
export async function memberEmailExists(tx: Tx, agencyId: string, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: agencyMembers.userId })
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.email, email)))
    .limit(1);
  return row !== undefined;
}

const openInvite = (now: Date) =>
  and(isNull(agencyInvites.acceptedAt), isNull(agencyInvites.revokedAt), gt(agencyInvites.expiresAt, now));

/** Seats in use: active members plus open, unexpired invites (one round trip). */
export async function countSeats(tx: Tx, agencyId: string, now: Date): Promise<number> {
  const r = await tx.execute<{ n: string | number }>(sql`
    select (select count(*) from ${agencyMembers}
             where ${agencyMembers.agencyId} = ${agencyId} and ${agencyMembers.deactivatedAt} is null)
         + (select count(*) from ${agencyInvites}
             where ${agencyInvites.agencyId} = ${agencyId} and ${openInvite(now)}) as n`);
  return Number(r.rows[0]?.n ?? 0);
}

const inviteColumns = {
  id: agencyInvites.id,
  email: agencyInvites.email,
  role: agencyInvites.role,
  expiresAt: agencyInvites.expiresAt,
  createdAt: agencyInvites.createdAt,
};

export interface InviteRow {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: Date;
  createdAt: Date;
}

/** Re-inviting an email replaces its open invite: the old link stops working. */
export async function revokeOpenInvites(tx: Tx, agencyId: string, email: string, now: Date): Promise<void> {
  await tx
    .update(agencyInvites)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(agencyInvites.agencyId, agencyId),
        eq(agencyInvites.email, email),
        isNull(agencyInvites.acceptedAt),
        isNull(agencyInvites.revokedAt),
      ),
    );
}

export async function insertInvite(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    locale: string;
    expiresAt: Date;
    createdAt: Date;
  },
): Promise<InviteRow> {
  const [inserted] = await tx
    .insert(agencyInvites)
    .values({ ...row, updatedAt: row.createdAt })
    .returning(inviteColumns);
  if (!inserted) throw new Error('insertInvite: no row returned');
  return inserted;
}

/** Open, unexpired invites, oldest first: keyset on `(created_at, id)`. */
export async function listOpenInvites(
  tx: Tx,
  agencyId: string,
  now: Date,
  q: { limit: number; cursor?: KeysetCursor },
): Promise<InviteRow[]> {
  return tx
    .select(inviteColumns)
    .from(agencyInvites)
    .where(
      and(
        eq(agencyInvites.agencyId, agencyId),
        openInvite(now),
        q.cursor
          ? or(
              gt(agencyInvites.createdAt, q.cursor.at),
              and(eq(agencyInvites.createdAt, q.cursor.at), gt(agencyInvites.id, q.cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(agencyInvites.createdAt), asc(agencyInvites.id))
    .limit(q.limit + 1);
}

/** An admin who is deactivated or loses the admin role: the invites they sent stop working. */
export async function revokeInvitesBy(tx: Tx, agencyId: string, invitedBy: string, now: Date): Promise<void> {
  await tx
    .update(agencyInvites)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(agencyInvites.agencyId, agencyId),
        eq(agencyInvites.invitedBy, invitedBy),
        isNull(agencyInvites.acceptedAt),
        isNull(agencyInvites.revokedAt),
      ),
    );
}

export async function revokeInvite(tx: Tx, agencyId: string, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(agencyInvites)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(agencyInvites.agencyId, agencyId),
        eq(agencyInvites.id, id),
        isNull(agencyInvites.acceptedAt),
        isNull(agencyInvites.revokedAt),
      ),
    )
    .returning({ id: agencyInvites.id });
  return rows.length === 1;
}

/** Email job (app_system): what the invite email needs, while the invite is still open. */
export async function findInviteForEmail(tx: Tx, id: string, now: Date) {
  const [row] = await tx
    .select({
      agencyId: agencyInvites.agencyId,
      email: agencyInvites.email,
      invitedBy: agencyInvites.invitedBy,
      locale: agencyInvites.locale,
    })
    .from(agencyInvites)
    .where(and(eq(agencyInvites.id, id), openInvite(now)));
  return row ?? null;
}

/** A new link replaces the previous one: only the latest emailed link works. */
export async function setInviteToken(tx: Tx, id: string, tokenHash: string, now: Date): Promise<void> {
  await tx.update(agencyInvites).set({ tokenHash, updatedAt: now }).where(eq(agencyInvites.id, id));
}

/** Accept flow (app_auth, scope pinned to the link's agency): the open invite behind a link. */
export async function findOpenInviteByToken(tx: Tx, agencyId: string, tokenHash: string, now: Date) {
  const [row] = await tx
    .select({
      id: agencyInvites.id,
      email: agencyInvites.email,
      role: agencyInvites.role,
      locale: agencyInvites.locale,
    })
    .from(agencyInvites)
    .where(and(eq(agencyInvites.agencyId, agencyId), eq(agencyInvites.tokenHash, tokenHash), openInvite(now)));
  return row ?? null;
}

/**
 * Single use: marks the invite accepted by `userId` in one statement, so two concurrent accepts of the
 * same link cannot both succeed. False when it was used, revoked or expired meanwhile.
 */
export async function markInviteAccepted(
  tx: Tx,
  id: string,
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(agencyInvites)
    .set({ acceptedAt: now, acceptedUserId: userId, updatedAt: now })
    .where(and(eq(agencyInvites.id, id), eq(agencyInvites.tokenHash, tokenHash), openInvite(now)))
    .returning({ id: agencyInvites.id });
  return rows.length === 1;
}

// ── Staff (S1-03) ───────────────────────────────────────────────────────────────────────────────

export type StaffRole = (typeof staffUsers.$inferSelect)['role'];

/** The user's active staff role (primary key). As `app_staff`, policy `staff_self` shows only that row. */
export async function findStaffRole(tx: Tx, userId: string): Promise<StaffRole | null> {
  const [row] = await tx
    .select({ role: staffUsers.role })
    .from(staffUsers)
    .where(and(eq(staffUsers.userId, userId), isNull(staffUsers.deactivatedAt)));
  return row?.role ?? null;
}

/** `pnpm staff:grant` (`app_system`): grants or changes a role, re-activating a withdrawn one. */
export async function upsertStaff(tx: Tx, userId: string, role: StaffRole): Promise<void> {
  await tx
    .insert(staffUsers)
    .values({ userId, role })
    .onConflictDoUpdate({ target: staffUsers.userId, set: { role, deactivatedAt: null } });
}

/** `pnpm staff:revoke`: staff access ends on the next request (`app_is_staff()`). */
export async function deactivateStaff(tx: Tx, userId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(staffUsers)
    .set({ deactivatedAt: now })
    .where(and(eq(staffUsers.userId, userId), isNull(staffUsers.deactivatedAt)))
    .returning({ userId: staffUsers.userId });
  return rows.length === 1;
}

/** Whether the user belongs to an agency (staff must not: their token would carry the agency). */
export async function hasMembership(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: agencyMembers.userId })
    .from(agencyMembers)
    .where(eq(agencyMembers.userId, userId));
  return row !== undefined;
}

/** Active admins of an agency with their UI locale, for agency notices sent by jobs (`app_system`). */
export async function listAdminRecipients(
  tx: Tx,
  agencyId: string,
): Promise<{ email: string; name: string; locale: string }[]> {
  return tx
    .select({ email: users.email, name: users.name, locale: users.locale })
    .from(agencyMembers)
    .innerJoin(users, eq(users.id, agencyMembers.userId))
    .where(
      and(
        eq(agencyMembers.agencyId, agencyId),
        inArray(agencyMembers.role, ['AGENCY_ADMIN', 'DEVELOPER_ADMIN']),
        isNull(agencyMembers.deactivatedAt),
        eq(users.status, 'ACTIVE'),
      ),
    )
    .orderBy(asc(agencyMembers.createdAt))
    .limit(20);
}
