import type { Tx } from '@inmolink/db';
import { agencyMembers, authTokens, users } from '@inmolink/db/schema/identity';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

/**
 * Identity tables only (PATTERNS §5). Runs as `app_auth` in request paths (`withAuth`) and as
 * `app_system` in the email job. Time comparisons take `now` from the platform clock, so expiry is
 * testable with a fake clock.
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

/** Inserts a user unless the email is taken. Returns the new id, or null when it already existed. */
export async function insertUserIfAbsent(
  tx: Tx,
  row: { id: string; email: string; passwordHash: string; name: string; locale: string },
): Promise<string | null> {
  const [inserted] = await tx
    .insert(users)
    .values(row)
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  return inserted?.id ?? null;
}

/**
 * A repeated sign-up for an email that was never confirmed takes over that pending account (new
 * password, name, locale): whoever controls the inbox decides which password the account gets.
 */
export async function replaceUnverifiedSignup(
  tx: Tx,
  email: string,
  row: { passwordHash: string; name: string; locale: string },
  now: Date,
): Promise<string | null> {
  const [updated] = await tx
    .update(users)
    .set({ ...row, updatedAt: now })
    .where(and(eq(users.email, email), isNull(users.emailVerifiedAt), eq(users.status, 'ACTIVE')))
    .returning({ id: users.id });
  return updated?.id ?? null;
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

/** Sign-up: the founding admin's membership (app_auth, scope pinned to the new agency and user). */
export async function insertMember(tx: Tx, row: { agencyId: string; userId: string; role: MemberRole }): Promise<void> {
  await tx.insert(agencyMembers).values(row);
}

/** The user's agency and role; one membership per user. */
export async function findMembership(tx: Tx, userId: string): Promise<{ agencyId: string; role: MemberRole } | null> {
  const [row] = await tx
    .select({ agencyId: agencyMembers.agencyId, role: agencyMembers.role })
    .from(agencyMembers)
    .where(eq(agencyMembers.userId, userId));
  return row ?? null;
}

/** The user's role in `agencyId` (primary-key lookup), or null if not a member there. */
export async function findMemberRole(tx: Tx, agencyId: string, userId: string): Promise<MemberRole | null> {
  const [row] = await tx
    .select({ role: agencyMembers.role })
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)));
  return row?.role ?? null;
}

export async function setMemberRole(tx: Tx, agencyId: string, userId: string, role: MemberRole, now: Date) {
  await tx
    .update(agencyMembers)
    .set({ role, updatedAt: now })
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)));
}
