import type {
  AcceptInviteInput,
  AccessTokenDto,
  Audience,
  ChangeMemberRoleInput,
  InviteDto,
  InviteMemberInput,
  InvitePage,
  InviteParams,
  LoginInput,
  MemberDto,
  MemberPage,
  MemberParams,
  MemberRole,
  PageQuery,
  RegisterInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  SessionUser,
  VerifyEmailInput,
} from '@inmolink/contracts';
import { setAuthScope, type Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { hmacSha256 } from '@inmolink/platform/crypto';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from '@inmolink/platform/crypto/password';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { type RateLimitRule, rateLimiter } from '@inmolink/platform/rate-limit';
import type { AuthCtx, Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as billing from '../billing';
import * as compliance from '../compliance';
import { identityConfig, TOKEN_TTL_MS, UNVERIFIED_SEAT_CAP } from './config';
import { identityEvents } from './events';
import * as impRepo from './impersonation-repo';
import { identityLog } from './log';
import { assertCan, canIssueAccessToken, IMPERSONATING_ROLES, loginDecision, sessionNeedsSecondFactor } from './policy';
import * as repo from './repo';
import { isDeviceRemembered, isSecondFactorRequired } from './two-factor';

/**
 * Anonymous auth flows (S0-09) and team management (S1-02). Inputs are already validated against the
 * contracts by the app. Auth responses never reveal whether an email is registered: sign-up and reset
 * requests always succeed, and a wrong password, an unknown email, a disabled account and a
 * deactivated member are the same error.
 */

/** `hmacSha256(HMAC_KEY, 'auth-token', token)` — what `auth_tokens.token_hash` stores. */
export function hashLinkToken(token: string): string {
  return hmacSha256(identityConfig().hmacKey, 'auth-token', token);
}

/** `hmacSha256(HMAC_KEY, 'invite-token', token)` — what `agency_invites.token_hash` stores. */
export function hashInviteToken(token: string): string {
  return hmacSha256(identityConfig().hmacKey, 'invite-token', token);
}

/** Invite links start with the agency id (32 hex digits), so the accept flow can pin its scope first. */
export function inviteTokenPrefix(agencyId: string): string {
  return agencyId.replaceAll('-', '').toLowerCase();
}

function agencyOfInviteToken(token: string): string {
  const hex = token.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Confirmation emails re-sent by logins to an unconfirmed account (S1-F4). Not a credential rule: when
 * Redis is down it fails open (the email is sent).
 */
const VERIFY_RESEND = {
  name: 'email.verify-resend',
  scope: 'user',
  limit: 1,
  windowSeconds: 10 * 60,
} as const satisfies RateLimitRule;

/** The founding member of an agency-of-one administers it (PLAN §3 #2). */
const FOUNDER_ROLE = { AGENCY: 'AGENCY_ADMIN', DEVELOPER: 'DEVELOPER_ADMIN' } as const satisfies Record<
  RegisterInput['accountKind'],
  MemberRole
>;

/**
 * Creates the account (unverified) together with its agency-of-one (PENDING) and the admin
 * membership, in one transaction (PLAN §3 #1, S1-01), and queues the confirmation email. A repeat
 * sign-up for an email that was never confirmed replaces that pending account and its agency's
 * details (and a fresh link retires the old one) — but only while that agency is still an untouched
 * sign-up (PENDING, not onboarded); otherwise, and for a confirmed email, the owner gets an "account
 * exists" email instead. Same screen either way.
 */
export async function register(ctx: AuthCtx, input: RegisterInput): Promise<void> {
  // Hash before the transaction, and for a taken email too, so timing does not reveal accounts.
  const passwordHash = await hashPassword(input.password);
  const now = clock.now();
  await ctx.transaction(async (tx) => {
    const profile = { passwordHash, name: input.name, locale: input.locale };
    const created = await repo.insertUserIfAbsent(tx, { id: newId(), email: input.email, ...profile });
    if (created) {
      // A platform event (nil agency): app_auth may append only those, whatever scope is set later.
      await emit(tx, identityEvents.registered({ userId: created }), { agencyId: PLATFORM_AGENCY_ID });
      await createAgencyOfOne(tx, created, input);
      return;
    }
    const existing = await repo.findSignupState(tx, input.email);
    if (existing?.status !== 'ACTIVE') return;
    // Staff have no agency and never get one (S1-F7): a sign-up with a staff email is a duplicate.
    await setAuthScope(tx, { userId: existing.id });
    const isStaff = (await repo.findStaffRole(tx, existing.id)) !== null;
    // Security review L3 (S1-01): the password is replaced only together with an untouched sign-up
    // agency, never for an account whose agency was onboarded or verified.
    if (!isStaff && !existing.emailVerifiedAt && (await replaceSignupAgency(tx, existing.id, input, now))) {
      await repo.replaceUnverifiedSignup(tx, existing.id, profile, now);
      await emit(tx, identityEvents.registered({ userId: existing.id }), { agencyId: PLATFORM_AGENCY_ID });
      return;
    }
    await emit(tx, identityEvents.signupDuplicated({ userId: existing.id }), { agencyId: PLATFORM_AGENCY_ID });
  });
}

async function createAgencyOfOne(tx: Tx, userId: string, input: RegisterInput): Promise<void> {
  const agencyId = newId();
  // The only agency and user the registry's `auth` predicates let this transaction write.
  await setAuthScope(tx, { agencyId, userId });
  await agencies.createSignupAgency(tx, {
    agencyId,
    kind: input.accountKind,
    name: input.companyName,
    uiLocale: input.locale,
  });
  await repo.insertMember(tx, {
    agencyId,
    userId,
    role: FOUNDER_ROLE[input.accountKind],
    name: input.name,
    email: input.email,
    createdAt: clock.now(),
  });
}

/** False when the account's agency may no longer be replaced (onboarded, verified, or not its own). */
async function replaceSignupAgency(tx: Tx, userId: string, input: RegisterInput, now: Date): Promise<boolean> {
  await setAuthScope(tx, { userId });
  const member = await repo.findMembership(tx, userId);
  if (!member) {
    // An account from before agencies existed (S0 data): give it its agency now.
    await createAgencyOfOne(tx, userId, input);
    return true;
  }
  await setAuthScope(tx, { agencyId: member.agencyId, userId });
  const replaced = await agencies.replaceSignupAgency(tx, {
    agencyId: member.agencyId,
    kind: input.accountKind,
    name: input.companyName,
  });
  if (replaced) {
    const patch = { role: FOUNDER_ROLE[input.accountKind], name: input.name };
    await repo.updateFounderMember(tx, member.agencyId, userId, patch, now);
  }
  return replaced;
}

/**
 * Confirms an email: needs the link **and** the account password. Someone who signed up with another
 * person's address cannot get it confirmed by that person clicking the link (pre-account hijack);
 * the real owner signs up again or resets the password instead. Unknown, used and expired links are
 * `TOKEN_INVALID`; a wrong password is `INVALID_CREDENTIALS` and leaves the link usable.
 */
export async function verifyEmail(ctx: AuthCtx, input: VerifyEmailInput): Promise<{ userId: string }> {
  const tokenHash = hashLinkToken(input.token);
  const now = clock.now();
  const owner = await ctx.transaction((tx) => repo.findTokenOwner(tx, tokenHash, 'EMAIL_VERIFY', now));
  if (!owner) throw new AppError('TOKEN_INVALID');
  if (!(await verifyPassword(owner.passwordHash, input.password))) throw new AppError('INVALID_CREDENTIALS');
  return ctx.transaction(async (tx) => {
    const userId = await repo.consumeToken(tx, tokenHash, 'EMAIL_VERIFY', now);
    if (userId !== owner.userId || !(await repo.markEmailVerified(tx, userId, owner.passwordHash, now))) {
      throw new AppError('TOKEN_INVALID');
    }
    return { userId };
  });
}

/**
 * The credential check behind Auth.js `authorize()`. Rate limits (per IP and per email) are the
 * caller's job and must run before this. An unconfirmed email gets a fresh link and
 * `EMAIL_NOT_VERIFIED` — only after the password matched, so it reveals nothing to a guesser.
 */
export async function verifyCredentials(
  ctx: AuthCtx,
  input: LoginInput & {
    /** The "remember this browser" cookie (S1-04), if any: a valid one skips the 2FA challenge. */
    deviceToken?: string;
  },
): Promise<SessionUser> {
  const found = await ctx.transaction(async (tx) => {
    const user = await repo.findCredentialsByEmail(tx, input.email);
    if (!user) return null;
    await setAuthScope(tx, { userId: user.id });
    const mfa = input.deviceToken ? await repo.findMfa(tx, user.id) : null;
    return { user, member: await repo.findMembership(tx, user.id), mfaConfirmedAt: mfa?.confirmedAt ?? null };
  });
  const matches = found
    ? await verifyPassword(found.user.passwordHash, input.password)
    : await dummyVerify(input.password);
  // Audit (S1-08): failed attempts on an existing account are recorded in their own transaction, before
  // the error; an unknown email is not (there is no account to name, and emails are not logged) but runs a
  // transaction of the same shape, so the response time does not tell the two apart. Both commit without
  // waiting for the WAL flush (`synchronous_commit = off`: a crash may lose the last few rows, never
  // corrupt them), and a failed audit write is logged, never turned into another answer than
  // INVALID_CREDENTIALS. Guessing is bounded before this by the per-IP and per-email login limits (web).
  const failed = async (reason: string) => {
    try {
      await ctx.transaction(async (tx) => {
        await repo.commitWithoutFlush(tx);
        if (!found) return setAuthScope(tx, { agencyId: PLATFORM_AGENCY_ID, userId: newId() });
        await compliance.auditAuth(tx, {
          type: 'identity.login.failed',
          userId: found.user.id,
          agencyId: found.member?.agencyId ?? null,
          authenticated: false,
          requestId: ctx.requestId,
          metadata: { reason },
        });
      });
    } catch (err) {
      identityLog().error({ err, requestId: ctx.requestId }, 'identity: failed-login audit not written');
    }
  };
  if (!found || !matches) {
    await failed('invalid_password');
    throw new AppError('INVALID_CREDENTIALS');
  }
  const { user, member } = found;

  const decision = loginDecision(user, member);
  if (decision === 'invalid') {
    await failed(user.status !== 'ACTIVE' ? 'account_disabled' : 'member_deactivated');
    throw new AppError('INVALID_CREDENTIALS');
  }
  if (decision === 'unverified') {
    await failed('email_not_verified');
    // One fresh link per user per 10 minutes, however often they try to log in (S1-F4): the first
    // attempt sends at once, the rest are covered by that email. The slot is spent before the event is
    // written: if that write fails (rare), the next link waits for the window (sliding: 10–20 min).
    const { allowed } = await rateLimiter().consume(VERIFY_RESEND, user.id);
    if (allowed) await ctx.transaction((tx) => emit(tx, identityEvents.verificationRequested({ userId: user.id })));
    throw new AppError('EMAIL_NOT_VERIFIED');
  }

  const rehash = needsRehash(user.passwordHash)
    ? { from: user.passwordHash, to: await hashPassword(input.password) }
    : undefined;
  const mfaVerified = isDeviceRemembered({
    userId: user.id,
    sessionVersion: user.sessionVersion,
    confirmedAt: found.mfaConfirmedAt,
    token: input.deviceToken,
  });
  await ctx.transaction(async (tx) => {
    await repo.recordLogin(tx, user.id, clock.now(), rehash);
    // The password step passed. Whether a second-factor challenge follows (S1-04) is recorded with it;
    // the challenge itself is `identity.twoFactor.verified` / `.failed`.
    await setAuthScope(tx, { userId: user.id });
    const enrolled = Boolean((await repo.findMfa(tx, user.id))?.confirmedAt);
    const required = sessionNeedsSecondFactor({
      enrolled,
      required: await isSecondFactorRequired(tx, user.id, member),
    });
    await compliance.auditAuth(tx, {
      type: 'identity.login.succeeded',
      userId: user.id,
      agencyId: member?.agencyId ?? null,
      authenticated: true,
      requestId: ctx.requestId,
      metadata: { secondFactor: mfaVerified ? 'remembered' : required ? 'required' : 'notRequired' },
    });
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    sessionVersion: user.sessionVersion,
    mfaVerified,
  };
}

/** Always succeeds; an active account gets a reset link (60 minutes, single use) by email. */
export async function requestPasswordReset(ctx: AuthCtx, input: RequestPasswordResetInput): Promise<void> {
  await ctx.transaction(async (tx) => {
    const user = await repo.findUserIdByEmail(tx, input.email);
    if (user?.status === 'ACTIVE') await emit(tx, identityEvents.passwordResetRequested({ userId: user.id }));
  });
}

/**
 * Consumes a reset link and sets the new password. Existing sessions are revoked: `session_version`
 * moves on, so the web session can no longer mint access tokens.
 */
export async function resetPassword(ctx: AuthCtx, input: ResetPasswordInput): Promise<{ userId: string }> {
  const tokenHash = hashLinkToken(input.token);
  const passwordHash = await hashPassword(input.password);
  const now = clock.now();
  return ctx.transaction(async (tx) => {
    const userId = await repo.consumeToken(tx, tokenHash, 'PASSWORD_RESET', now);
    // Throwing rolls the consumption back too; the link stays unusable only if the reset committed.
    if (!userId || !(await repo.setPassword(tx, userId, passwordHash, now))) throw new AppError('TOKEN_INVALID');
    await setAuthScope(tx, { userId });
    const member = await repo.findMembership(tx, userId);
    await compliance.auditAuth(tx, {
      type: 'identity.password.reset',
      userId,
      agencyId: member?.agencyId ?? null,
      authenticated: true,
      requestId: ctx.requestId,
    });
    return { userId };
  });
}

/** The user and their membership, for session checks and token mints (app_auth, scope = the user). */
async function loadSessionSubject(tx: Tx, userId: string) {
  const user = await repo.findUserForToken(tx, userId);
  if (!user) return null;
  await setAuthScope(tx, { userId });
  return { user, member: await repo.findMembership(tx, userId) };
}

/** Whether this user's sessions must pass the second factor before minting (S1-04). */
async function needsSecondFactor(
  tx: Tx,
  userId: string,
  member: { role: string; deactivatedAt: Date | null } | null,
): Promise<boolean> {
  const enrolled = Boolean((await repo.findMfa(tx, userId))?.confirmedAt);
  // Enrolled users need it whatever their role: skip the role lookup.
  return sessionNeedsSecondFactor({
    enrolled,
    required: !enrolled && (await isSecondFactorRequired(tx, userId, member)),
  });
}

/**
 * Whether a web session may continue: the user is active and verified, the session was not revoked
 * (password reset bumps `session_version`) and their agency did not deactivate them. Auth.js
 * re-checks this every few minutes.
 */
export async function isSessionValid(
  ctx: AuthCtx,
  input: { userId: string; sessionVersion: number },
): Promise<boolean> {
  const found = await ctx.transaction((tx) => loadSessionSubject(tx, input.userId));
  return found !== null && canIssueAccessToken(found.user, input.sessionVersion, found.member);
}

/**
 * Mints a 15-minute access token for `api` or `realtime` from a web session. Re-checks the user and
 * their membership on every mint, so a password reset or deactivation ends API access at once (the
 * API also reads the membership per request). Every dashboard page and action reaches data through
 * this mint, so it is where 2FA is enforced: `MFA_REQUIRED` until the session passed it (S1-04).
 */
export async function issueAccessToken(
  ctx: AuthCtx,
  input: {
    userId: string;
    sessionVersion: number;
    audience: Audience;
    /** The web session passed the second factor (S1-04). */
    mfaVerified: boolean;
    /** The staff member's open impersonation session (S1-09): mint a token that acts as its member. */
    impersonationId?: string;
  },
): Promise<AccessTokenDto> {
  const { signer } = identityConfig();
  if (!signer) throw new Error('identity: no access token signer configured');
  if (input.impersonationId !== undefined)
    return issueImpersonationToken(ctx, { ...input, impersonationId: input.impersonationId });
  const found = await ctx.transaction(async (tx) => {
    const subject = await loadSessionSubject(tx, input.userId);
    if (!subject || !canIssueAccessToken(subject.user, input.sessionVersion, subject.member)) return null;
    // Enrolled, staff or admin: no token until this session passed 2FA (enrolling if it has none).
    if (!input.mfaVerified && (await needsSecondFactor(tx, input.userId, subject.member))) return 'mfa' as const;
    return subject;
  });
  if (!found) throw new AppError('SESSION_REVOKED');
  if (found === 'mfa') throw new AppError('MFA_REQUIRED');
  const { token, expiresAt } = await signer.sign({
    sub: input.userId,
    aud: input.audience,
    sv: found.user.sessionVersion,
    // The tenant; the role is read per request, so a role change applies at once (S1-02).
    ...(found.member ? { agency: found.member.agencyId } : {}),
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * The impersonation mint (S1-09): the web session is the staff member's. They must be active staff with
 * no agency, have passed 2FA in this session, and own the live session named; the token then acts as
 * the session's member (`sub`) in its agency, naming the staff member (`act`) and the session (`imp`).
 * API audience only. The API re-checks the session on every request, so ending it applies at once.
 */
async function issueImpersonationToken(
  ctx: AuthCtx,
  input: { userId: string; sessionVersion: number; audience: Audience; mfaVerified: boolean; impersonationId: string },
): Promise<AccessTokenDto> {
  const { signer } = identityConfig();
  if (!signer) throw new Error('identity: no access token signer configured');
  if (input.audience !== 'api') throw new AppError('FORBIDDEN', { reason: 'impersonation_audience' });
  // Staff always need 2FA (S1-04): an impersonation never starts from a session that skipped it.
  if (!input.mfaVerified) throw new AppError('MFA_REQUIRED');
  const found = await ctx.transaction(async (tx) => {
    const subject = await loadSessionSubject(tx, input.userId);
    if (!subject || !canIssueAccessToken(subject.user, input.sessionVersion, subject.member)) return null;
    const role = subject.member ? null : await repo.findStaffRole(tx, input.userId);
    if (!role || !IMPERSONATING_ROLES.includes(role)) return 'not_staff' as const;
    const session = await impRepo.findLiveSession(tx, input.userId, input.impersonationId);
    if (!session) return 'ended' as const;
    // Never act as another staff member (S1-09 review). Staff cannot see each other's `staff_users` rows,
    // so this is checked here: app_auth reads the target's own row with the scope narrowed to them.
    await setAuthScope(tx, { userId: session.targetUserId });
    if (await repo.findStaffRole(tx, session.targetUserId)) return 'target_staff' as const;
    return { sessionVersion: subject.user.sessionVersion, session };
  });
  if (!found) throw new AppError('SESSION_REVOKED');
  if (found === 'not_staff') throw new AppError('FORBIDDEN', { reason: 'not_staff' });
  if (found === 'target_staff') throw new AppError('IMPERSONATION_TARGET_INVALID');
  if (found === 'ended') throw new AppError('IMPERSONATION_ENDED');
  const { token, expiresAt } = await signer.sign({
    sub: found.session.targetUserId,
    aud: 'api',
    sv: found.sessionVersion,
    agency: found.session.agencyId,
    act: input.userId,
    imp: found.session.id,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * The caller's role in the agency named by their access token, inside the request's `withTenant`
 * transaction (RLS: own agency only). Null when the user is not (or no longer) an active member.
 */
export async function getMemberRole(tx: Tx, agencyId: string, userId: string): Promise<MemberRole | null> {
  return repo.findMemberRole(tx, agencyId, userId);
}

// ── Team (S1-02) ────────────────────────────────────────────────────────────────────────────────

function toMemberDto(row: repo.MemberRow): MemberDto {
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.deactivatedAt ? 'DEACTIVATED' : 'ACTIVE',
    joinedAt: row.createdAt.toISOString(),
  };
}

function toInviteDto(row: repo.InviteRow): InviteDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The caller's team, deactivated members included, oldest first. */
export async function listMembers(ctx: Ctx, q: PageQuery): Promise<MemberPage> {
  assertCan(ctx, 'identity.members.read');
  const rows = await repo.listMembers(ctx.tx, ctx.tenant.agencyId, { limit: q.limit, cursor: decodeCursor(q.cursor) });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.userId }), toMemberDto);
}

/**
 * Invites `email` with `role` (admins only, roles of their own family). Inviting the same email again
 * replaces its open invite. The seat check counts active members and open invites (`billing.assertSeat`,
 * a stub until S13). The email job creates the link (7 days, single use).
 */
export async function inviteMember(ctx: Ctx, input: InviteMemberInput): Promise<InviteDto> {
  assertCan(ctx, 'identity.members.manage', { role: input.role });
  const { agencyId } = ctx.tenant;
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  if (await repo.memberEmailExists(ctx.tx, agencyId, input.email)) throw new AppError('ALREADY_MEMBER');
  const now = clock.now();
  await repo.revokeOpenInvites(ctx.tx, agencyId, input.email, now);
  const used = await repo.countSeats(ctx.tx, agencyId, now);
  if (!ctx.tenant.verified && used >= UNVERIFIED_SEAT_CAP) {
    throw new AppError('VERIFICATION_REQUIRED', { action: 'invite', limit: UNVERIFIED_SEAT_CAP });
  }
  await billing.assertSeat(ctx, { used });
  const invite = await repo.insertInvite(ctx.tx, {
    id: newId(),
    agencyId,
    email: input.email,
    role: input.role,
    invitedBy: ctx.actor.userId,
    locale: input.locale ?? ctx.locale,
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS.INVITE),
    createdAt: now,
  });
  await emit(ctx.tx, identityEvents.inviteCreated({ agencyId, inviteId: invite.id }));
  // The role is granted when the invite is accepted (`identity.member.joined`); never the email here.
  await compliance.audit(ctx, 'identity.member.invited', { type: 'invite', id: invite.id }, { role: input.role });
  return toInviteDto(invite);
}

/** Open, unexpired invites of the caller's agency (admins only). */
export async function listInvites(ctx: Ctx, q: PageQuery): Promise<InvitePage> {
  assertCan(ctx, 'identity.members.manage');
  const rows = await repo.listOpenInvites(ctx.tx, ctx.tenant.agencyId, clock.now(), {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.id }), toInviteDto);
}

/** Withdraws an open invite: its link stops working. `NOT_FOUND` if it was used or revoked already. */
export async function revokeInvite(ctx: Ctx, input: InviteParams): Promise<void> {
  assertCan(ctx, 'identity.members.manage');
  if (!(await repo.revokeInvite(ctx.tx, ctx.tenant.agencyId, input.inviteId, clock.now()))) {
    throw new AppError('NOT_FOUND');
  }
}

const ADMIN_ROLES: readonly MemberRole[] = ['AGENCY_ADMIN', 'DEVELOPER_ADMIN'];

/**
 * Locks the caller's and the target's membership and checks the change against both as they are now
 * (not as `ctx` saw them at the start of the request): the caller must still be an active admin with
 * the same role, and the target a member whose current role this admin manages.
 */
async function lockForChange(ctx: Ctx, userId: string): Promise<repo.MemberRow> {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  const callerId = ctx.actor.userId;
  const rows = await repo.lockMembers(ctx.tx, ctx.tenant.agencyId, [callerId, userId]);
  const caller = rows.find((r) => r.userId === callerId);
  const target = rows.find((r) => r.userId === userId);
  if (!caller || caller.deactivatedAt || caller.role !== ctx.actor.role) throw new AppError('FORBIDDEN');
  if (!target) throw new AppError('NOT_FOUND');
  assertCan(ctx, 'identity.members.manage', { userId, role: target.role });
  return target;
}

/**
 * Changes a member's role (admins only, within their own family, never their own). The API reads the
 * role per request, so it applies on the member's next call. An admin who loses the admin role loses
 * the invites they sent. A database guard enforces the same rules.
 */
export async function changeMemberRole(ctx: Ctx, input: ChangeMemberRoleInput): Promise<MemberDto> {
  assertCan(ctx, 'identity.members.manage', { userId: input.userId, role: input.role });
  const { agencyId } = ctx.tenant;
  const current = await lockForChange(ctx, input.userId);
  if (current.role === input.role) return toMemberDto(current);
  const now = clock.now();
  const updated = await repo.updateMember(ctx.tx, agencyId, input.userId, { role: input.role }, now);
  if (!updated) throw new AppError('NOT_FOUND');
  if (ADMIN_ROLES.includes(current.role) && !ADMIN_ROLES.includes(input.role)) {
    await repo.revokeInvitesBy(ctx.tx, agencyId, input.userId, now);
  }
  await emit(ctx.tx, identityEvents.memberRoleChanged({ agencyId, userId: input.userId, role: input.role }));
  await compliance.audit(
    ctx,
    'identity.member.roleChanged',
    { type: 'user', id: input.userId },
    { from: current.role, to: input.role },
  );
  return toMemberDto(updated);
}

/**
 * Deactivates a member (admins only, never themselves). From the commit on, the user cannot log in,
 * their web session ends at its next check, no access token is minted, the API refuses them, and the
 * invites they sent stop working. Idempotent.
 */
export async function deactivateMember(ctx: Ctx, input: MemberParams): Promise<MemberDto> {
  assertCan(ctx, 'identity.members.manage', { userId: input.userId });
  const { agencyId } = ctx.tenant;
  const current = await lockForChange(ctx, input.userId);
  if (current.deactivatedAt) return toMemberDto(current);
  const now = clock.now();
  const updated = await repo.updateMember(ctx.tx, agencyId, input.userId, { deactivatedAt: now }, now);
  if (!updated) throw new AppError('NOT_FOUND');
  await repo.revokeInvitesBy(ctx.tx, agencyId, input.userId, now);
  await emit(ctx.tx, identityEvents.memberDeactivated({ agencyId, userId: input.userId }));
  await compliance.audit(ctx, 'identity.member.deactivated', { type: 'user', id: input.userId });
  return toMemberDto(updated);
}

/**
 * Accepts an invite (anonymous, `app_auth`): creates the account with the invited email — confirmed,
 * since the link proves the inbox — and joins the inviting agency with the invited role, in one
 * transaction. The link works once: unknown, used, revoked and expired links are `TOKEN_INVALID`. An
 * email that already has an account is `INVITE_EMAIL_IN_USE` (one agency per user, PLAN §3 #1) and
 * leaves the invite usable.
 */
export async function acceptInvite(ctx: AuthCtx, input: AcceptInviteInput): Promise<{ userId: string; email: string }> {
  const agencyId = agencyOfInviteToken(input.token);
  const tokenHash = hashInviteToken(input.token);
  // Hash before the transaction (tens of ms of CPU), as sign-up does.
  const passwordHash = await hashPassword(input.password);
  const now = clock.now();
  return ctx.transaction(async (tx) => {
    // The registry's `auth` predicates let app_auth see only this agency's open invites.
    await setAuthScope(tx, { agencyId });
    const invite = await repo.findOpenInviteByToken(tx, agencyId, tokenHash, now);
    if (!invite) throw new AppError('TOKEN_INVALID');
    const userId = await repo.insertUserIfAbsent(tx, {
      id: newId(),
      email: invite.email,
      passwordHash,
      name: input.name,
      locale: invite.locale,
      emailVerifiedAt: now,
    });
    if (!userId) throw new AppError('INVITE_EMAIL_IN_USE');
    await setAuthScope(tx, { agencyId, userId });
    if (!(await repo.markInviteAccepted(tx, invite.id, tokenHash, userId, now))) throw new AppError('TOKEN_INVALID');
    const member = { agencyId, userId, role: invite.role, name: input.name, email: invite.email, createdAt: now };
    await repo.insertMember(tx, member);
    await compliance.auditAuth(tx, {
      type: 'identity.member.joined',
      userId,
      agencyId,
      authenticated: true,
      requestId: ctx.requestId,
      metadata: { role: invite.role, inviteId: invite.id },
    });
    return { userId, email: invite.email };
  });
}
