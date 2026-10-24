import type { Tx } from '@inmolink/db';
import {
  agencyInvites,
  agencyMembers,
  authTokens,
  staffUsers,
  userMfa,
  userRecoveryCodes,
  users,
} from '@inmolink/db/schema/identity';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

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
        keysetAfter(agencyMembers.createdAt, agencyMembers.userId, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrder(agencyMembers.createdAt, agencyMembers.userId, 'asc'))
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
        keysetAfter(agencyInvites.createdAt, agencyInvites.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrder(agencyInvites.createdAt, agencyInvites.id, 'asc'))
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

/**
 * An impersonating staff member's login and active staff role in one read (S2-F1), as `app_auth` scoped to
 * that user (`staff_users` policy `auth_self`). Null when either row is missing or the staff role is withdrawn.
 */
export async function findImpersonatorLogin(
  tx: Tx,
  userId: string,
): Promise<{ status: string; sessionVersion: number; role: StaffRole } | null> {
  const [row] = await tx
    .select({ status: users.status, sessionVersion: users.sessionVersion, role: staffUsers.role })
    .from(users)
    .innerJoin(staffUsers, and(eq(staffUsers.userId, users.id), isNull(staffUsers.deactivatedAt)))
    .where(eq(users.id, userId));
  return row ?? null;
}

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
): Promise<{ userId: string; email: string; name: string; locale: string }[]> {
  return tx
    .select({ userId: users.id, email: users.email, name: users.name, locale: users.locale })
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

/**
 * S10-02: the agency's active members who work clients (lead round robin), by user id — the tenant's own rows
 * (`agency_members`, RLS), at most `limit`.
 */
export async function activeClientMemberIds(tx: Tx, agencyId: string, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ userId: agencyMembers.userId })
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, agencyId),
        inArray(agencyMembers.role, ['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']),
        isNull(agencyMembers.deactivatedAt),
      ),
    )
    .orderBy(asc(agencyMembers.userId))
    .limit(limit);
  return rows.map((r) => r.userId);
}

/**
 * S10-06: which of these users are active members of the agency who work clients (calendar attendees). One statement
 * (primary key `(agency_id, user_id)`).
 */
export async function activeClientMembersAmong(
  tx: Tx,
  agencyId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .select({ userId: agencyMembers.userId })
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, agencyId),
        inArray(agencyMembers.userId, [...userIds]),
        inArray(agencyMembers.role, ['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']),
        isNull(agencyMembers.deactivatedAt),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/** S10-02: an active member's login e-mail, name and UI locale, for a lead notification (`app_system`). */
export async function memberRecipient(
  tx: Tx,
  agencyId: string,
  userId: string,
): Promise<{ userId: string; email: string; name: string; locale: string } | null> {
  const [row] = await tx
    .select({ userId: users.id, email: users.email, name: users.name, locale: users.locale })
    .from(agencyMembers)
    .innerJoin(users, eq(users.id, agencyMembers.userId))
    .where(
      and(
        eq(agencyMembers.agencyId, agencyId),
        eq(agencyMembers.userId, userId),
        isNull(agencyMembers.deactivatedAt),
        eq(users.status, 'ACTIVE'),
      ),
    );
  return row ?? null;
}

/**
 * Maintenance (S1-F4, `app_system`): deletes up to `limit` link tokens that expired or were used
 * before `before`. Returns how many went.
 */
export async function deleteExpiredTokens(tx: Tx, before: Date, limit: number): Promise<number> {
  const batch = tx
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(or(lt(authTokens.expiresAt, before), lt(authTokens.usedAt, before)))
    .limit(limit);
  const rows = await tx.delete(authTokens).where(inArray(authTokens.id, batch)).returning({ id: authTokens.id });
  return rows.length;
}

// ── Two-factor (S1-04, app_auth scoped to the user) ──────────────────────────────────────────────

export interface MfaRow {
  /** AES-256-GCM envelope; null after 2FA was disabled. */
  totpSecret: string | null;
  confirmedAt: Date | null;
  lastUsedStep: number | null;
  /** Bumped by "forget all remembered browsers"; part of the browser token's signature. */
  deviceEpoch: number;
}

export async function findMfa(tx: Tx, userId: string): Promise<MfaRow | null> {
  const [row] = await tx
    .select({
      totpSecret: userMfa.totpSecret,
      confirmedAt: userMfa.confirmedAt,
      lastUsedStep: userMfa.lastUsedStep,
      deviceEpoch: userMfa.deviceEpoch,
    })
    .from(userMfa)
    .where(eq(userMfa.userId, userId));
  return row ?? null;
}

/**
 * 2FA enrolment and staff state in one query (S1-F8: the token mint ran two). `app_auth`, scope = the
 * user; staff rows are visible to their own user only.
 */
export async function findSecondFactorState(tx: Tx, userId: string): Promise<{ enrolled: boolean; isStaff: boolean }> {
  const [row] = await tx
    .select({ confirmedAt: userMfa.confirmedAt, staffUserId: staffUsers.userId })
    .from(users)
    .leftJoin(userMfa, eq(userMfa.userId, users.id))
    .leftJoin(staffUsers, and(eq(staffUsers.userId, users.id), isNull(staffUsers.deactivatedAt)))
    .where(eq(users.id, userId));
  return { enrolled: Boolean(row?.confirmedAt), isStaff: Boolean(row?.staffUserId) };
}

/** The stored password hash, for a fresh-password check before an account setting changes. */
export async function findPasswordHash(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
  return row?.passwordHash ?? null;
}

/** Invalidates every remembered browser: the epoch is part of their signature. */
export async function bumpDeviceEpoch(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx
    .update(userMfa)
    .set({ deviceEpoch: sql`${userMfa.deviceEpoch} + 1`, updatedAt: now })
    .where(eq(userMfa.userId, userId));
}

/** Stores a new, unconfirmed secret — unless 2FA is enabled (then false: disable it first). */
export async function upsertPendingMfa(tx: Tx, userId: string, totpSecret: string, now: Date): Promise<boolean> {
  const rows = await tx
    .insert(userMfa)
    .values({ userId, totpSecret, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: userMfa.userId,
      set: { totpSecret, confirmedAt: null, lastUsedStep: null, updatedAt: now },
      setWhere: isNull(userMfa.confirmedAt),
    })
    .returning({ userId: userMfa.userId });
  return rows.length === 1;
}

const stepIsNew = (step: number) => or(isNull(userMfa.lastUsedStep), lt(userMfa.lastUsedStep, step));

/** Enrolment's first code: confirms the pending secret it was checked against (`secret` pins it). */
export async function confirmMfa(tx: Tx, userId: string, secret: string, step: number, now: Date): Promise<boolean> {
  const rows = await tx
    .update(userMfa)
    .set({ confirmedAt: now, lastUsedStep: step, updatedAt: now })
    .where(and(eq(userMfa.userId, userId), isNull(userMfa.confirmedAt), eq(userMfa.totpSecret, secret)))
    .returning({ userId: userMfa.userId });
  return rows.length === 1;
}

/** Accepts a TOTP step once: false when this or a later step was already used (replay). */
export async function useTotpStep(tx: Tx, userId: string, step: number, now: Date): Promise<boolean> {
  const rows = await tx
    .update(userMfa)
    .set({ lastUsedStep: step, updatedAt: now })
    .where(and(eq(userMfa.userId, userId), isNotNull(userMfa.confirmedAt), stepIsNew(step)))
    .returning({ userId: userMfa.userId });
  return rows.length === 1;
}

/** Turns 2FA off: the secret is dropped (app_auth never deletes rows). */
export async function disableMfa(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx
    .update(userMfa)
    .set({ totpSecret: null, confirmedAt: null, lastUsedStep: null, updatedAt: now })
    .where(eq(userMfa.userId, userId));
}

export async function insertRecoveryCodes(
  tx: Tx,
  rows: { id: string; userId: string; codeHash: string; createdAt: Date }[],
): Promise<void> {
  await tx.insert(userRecoveryCodes).values(rows);
}

/** Retires every open recovery code (new set, or 2FA disabled). */
export async function retireRecoveryCodes(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx
    .update(userRecoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
}

/** Uses a recovery code: one `UPDATE … WHERE used_at IS NULL`, so it works exactly once. */
export async function consumeRecoveryCode(tx: Tx, userId: string, codeHash: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(userRecoveryCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(userRecoveryCodes.userId, userId),
        eq(userRecoveryCodes.codeHash, codeHash),
        isNull(userRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: userRecoveryCodes.id });
  return rows.length === 1;
}

export async function countRecoveryCodes(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return row?.n ?? 0;
}

/**
 * The transaction commits without waiting for its WAL flush (S1-08: failed-login audit rows). Only for
 * writes whose loss in a crash is acceptable; never for business data.
 */
export async function commitWithoutFlush(tx: Tx): Promise<void> {
  await tx.execute(sql`set local synchronous_commit = off`);
}

/** Display names of login identities, for staff-facing records (`app_auth` reads `users`). */
export async function findUserNames(tx: Tx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...ids]));
}

/**
 * The team directory names and e-mails of these agencies' members, deactivated ones included (S7-F5: removed from
 * their agencies' indexed listing text). One statement on `agency_members_agency_created_idx`; raw `tx` under
 * `withSystem`.
 */
export async function teamContacts(
  tx: Tx,
  agencyIds: readonly string[],
): Promise<{ agencyId: string; name: string; email: string }[]> {
  if (agencyIds.length === 0) return [];
  return tx
    .select({ agencyId: agencyMembers.agencyId, name: agencyMembers.name, email: agencyMembers.email })
    .from(agencyMembers)
    .where(inArray(agencyMembers.agencyId, [...agencyIds]));
}

/** S10-09: members' display names by user id (deactivated ones included: their past work stays attributed), one statement. */
export async function memberNames(tx: Tx, agencyId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({ userId: agencyMembers.userId, name: agencyMembers.name })
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), inArray(agencyMembers.userId, [...userIds])));
  return new Map(rows.map((r) => [r.userId, r.name]));
}
