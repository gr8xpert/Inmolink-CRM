import type {
  ImpersonationDto,
  ImpersonationParams,
  LiveImpersonationList,
  MemberPage,
  PageQuery,
  StaffAccessPage,
  StaffMeDto,
  StartImpersonationInput,
} from '@inmolink/contracts';
import { type Tx, withAuth } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { Ctx, StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as impRepo from './impersonation-repo';
import { assertCan, assertStaffCan, IMPERSONATING_ROLES } from './policy';
import * as repo from './repo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live sessions listed at most (one open per staff member, so the staff team's size bounds it). */
const MAX_LIVE_SESSIONS = 100;

/**
 * Names of login identities for staff-facing pages (the audit viewer, live sessions): one `app_auth` read,
 * since `app_staff` cannot see `users`. Unknown ids are absent from the map. Names are member data:
 * super admins and support only (`staff.members.read`), like the members list.
 */
export async function userNames(ctx: StaffCtx, ids: readonly string[]): Promise<Map<string, string>> {
  assertStaffCan(ctx, 'staff.members.read');
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await withAuth((tx) => repo.findUserNames(tx, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Staff impersonation (S1-09, PLAN §7 M20 §12, `.claude/rules/security.md`). A staff member who passed
 * 2FA starts a session for one active member of an agency, with a reason, for 5–60 minutes. Sessions
 * live in `staff_impersonations` (one open per staff member), so they can be ended at once:
 *
 * 1. `startImpersonation` (app_staff) records the session and audits `staff.impersonation.started`.
 * 2. The web mints an access token for it (`issueAccessToken` with `impersonationId`, app_auth): `sub`
 *    is the member, `act` the staff member, `imp` the session; only while the session is live.
 * 3. Every API request with that token re-checks the session in its own transaction (`withMemberCtx` →
 *    `getMemberAccess`, app_user) and runs with `actor.impersonatedBy` and `app.impersonated_by`
 *    set, so every audit row and event names both people. Ending or expiry applies on the next request.
 * 4. What an impersonated session may never do is one list (`IMPERSONATION_FORBIDDEN`).
 */

function toDto(s: impRepo.SessionRow, names: { agencyName: string; userName: string }): ImpersonationDto {
  return {
    id: s.id,
    agencyId: s.agencyId,
    agencyName: names.agencyName,
    userId: s.targetUserId,
    userName: names.userName,
    startedAt: s.startedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  };
}

/**
 * `POST /v1/staff/impersonations`: support and super admins act as an active member of an agency that
 * is not suspended. A previous open session of the same staff member ends first (one at a time). The
 * reason stays on the session row; the audit row records ids and the length only.
 */
export async function startImpersonation(ctx: StaffCtx, input: StartImpersonationInput): Promise<ImpersonationDto> {
  assertStaffCan(ctx, 'staff.impersonate');
  // One start at a time per staff member (S1-09 review): a concurrent start waits here, then ends this
  // one's session instead of hitting the one-open-session index (23505).
  await impRepo.lockStaffSessions(ctx.tx, ctx.actor.userId);
  const tenant = await agencies.getTenantSummary(ctx, { agencyId: input.agencyId });
  const member = await impRepo.findMember(ctx.tx, input.agencyId, input.userId);
  if (tenant.status === 'SUSPENDED' || !member || member.deactivatedAt || input.userId === ctx.actor.userId) {
    throw new AppError('IMPERSONATION_TARGET_INVALID');
  }
  for (const ended of await impRepo.endOpenSessions(ctx.tx, ctx.actor.userId)) {
    await compliance.auditStaff(ctx, ended.agencyId, 'staff.impersonation.ended', null, {
      impersonationId: ended.id,
      cause: 'replaced',
    });
  }
  const session = await impRepo.insertSession(ctx.tx, {
    id: newId(),
    agencyId: input.agencyId,
    staffUserId: ctx.actor.userId,
    targetUserId: input.userId,
    reason: input.reason,
    minutes: input.minutes,
  });
  await compliance.auditStaff(
    ctx,
    input.agencyId,
    'staff.impersonation.started',
    { type: 'user', id: input.userId },
    { impersonationId: session.id, minutes: input.minutes, reasonProvided: true },
  );
  return toDto(session, { agencyName: tenant.name, userName: member.name });
}

/** `POST /v1/staff/impersonations/:id/end`: ends the caller's own open session (also an expired one). */
export async function endImpersonation(ctx: StaffCtx, input: ImpersonationParams): Promise<void> {
  const ended = await impRepo.endSession(ctx.tx, input.id, ctx.actor.userId);
  // Not the caller's own: a super admin may end a colleague's live session (S1-F9).
  if (!ended && ctx.actor.role === 'SUPER_ADMIN') return endImpersonationAsSuperAdmin(ctx, input);
  if (!ended) throw new AppError('NOT_FOUND', { entity: 'impersonation' });
  await compliance.auditStaff(
    ctx,
    ended.agencyId,
    'staff.impersonation.ended',
    { type: 'user', id: ended.targetUserId },
    { impersonationId: ended.id, cause: 'ended' },
  );
}

/**
 * `POST /v1/staff/impersonations/:id/end` for a session that is not the caller's own (S1-F9): a super admin
 * ends any staff member's live session, e.g. of a colleague who is no longer trusted. Audited under the
 * agency with the cause `endedBySuperAdmin`; the staff member's next request answers `IMPERSONATION_ENDED`.
 */
export async function endImpersonationAsSuperAdmin(ctx: StaffCtx, input: ImpersonationParams): Promise<void> {
  assertStaffCan(ctx, 'staff.impersonation.manage');
  const ended = await impRepo.endAnySession(ctx.tx, input.id);
  if (!ended) throw new AppError('NOT_FOUND', { entity: 'impersonation' });
  await compliance.auditStaff(
    ctx,
    ended.agencyId,
    'staff.impersonation.ended',
    { type: 'user', id: ended.targetUserId },
    { impersonationId: ended.id, cause: 'endedBySuperAdmin', staffUserId: ended.staffUserId },
  );
}

/** `GET /v1/staff/impersonations`: every live session with both people's names (super admins only). */
export async function listLiveImpersonations(ctx: StaffCtx): Promise<LiveImpersonationList> {
  assertStaffCan(ctx, 'staff.impersonation.manage');
  const sessions = await impRepo.listLiveSessions(ctx.tx, MAX_LIVE_SESSIONS);
  const [names, agencyNames] = await Promise.all([
    userNames(
      ctx,
      sessions.flatMap((s) => [s.staffUserId, s.targetUserId]),
    ),
    agencies.agencyNames(
      ctx,
      sessions.map((s) => s.agencyId),
    ),
  ]);
  return {
    items: sessions.map((s) => ({
      id: s.id,
      agencyId: s.agencyId,
      agencyName: agencyNames.get(s.agencyId) ?? '',
      userId: s.targetUserId,
      userName: names.get(s.targetUserId) ?? '',
      startedAt: s.startedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      staffUserId: s.staffUserId,
      staffName: names.get(s.staffUserId) ?? '',
    })),
  };
}

/**
 * `GET /v1/staff-access` (S1-F9): the agency's admins see when Inmolink staff acted as one of their
 * members, and the reason the staff member gave — newest first, keyset pages. Staff identities stay out.
 */
export async function listStaffAccess(ctx: Ctx, q: PageQuery): Promise<StaffAccessPage> {
  assertCan(ctx, 'identity.staffAccess.read');
  const rows = await impRepo.listStaffAccess(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.startedAt, id: r.id }),
    (r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      status: r.status,
      memberUserId: r.memberUserId,
      memberName: r.memberName,
      reason: r.reason,
    }),
  );
}

/** `GET /v1/staff/me`: the caller's staff role and live impersonation session (the web banner). */
export async function getStaffMe(ctx: StaffCtx): Promise<StaffMeDto> {
  const session = await impRepo.findLiveSession(ctx.tx, ctx.actor.userId);
  let impersonation: ImpersonationDto | null = null;
  if (session) {
    const tenant = await agencies.getTenantSummary(ctx, { agencyId: session.agencyId });
    const member = await impRepo.findMember(ctx.tx, session.agencyId, session.targetUserId);
    impersonation = toDto(session, { agencyName: tenant.name, userName: member?.name ?? '' });
  }
  return { userId: ctx.actor.userId, role: ctx.actor.role, impersonation };
}

/**
 * `GET /v1/staff/agencies/:agencyId/members`: the agency's team (deactivated included), oldest first.
 * Names and emails: support and super admins only, and each read is audited (`staff.members.read`).
 */
export async function listAgencyMembers(ctx: StaffCtx, input: { agencyId: string } & PageQuery): Promise<MemberPage> {
  assertStaffCan(ctx, 'staff.members.read');
  const rows = await repo.listMembers(ctx.tx, input.agencyId, {
    limit: input.limit,
    cursor: decodeCursor(input.cursor),
  });
  await compliance.auditStaff(
    ctx,
    input.agencyId,
    'staff.members.read',
    { type: 'agency', id: input.agencyId },
    { nextPage: input.cursor !== undefined },
  );
  return toPage(
    rows,
    input.limit,
    (r) => ({ at: r.createdAt, id: r.userId, atUs: r.atUs }),
    (r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.deactivatedAt ? 'DEACTIVATED' : 'ACTIVE',
      joinedAt: r.createdAt.toISOString(),
    }),
  );
}

/**
 * The request ctx's read inside its `withTenant` transaction (app_user, S2-F1): the caller's active role
 * and, when `impersonationId` is set, whether that session is still live for this user and agency (not
 * readable per staff member by app_user, S1-F10). One statement; `withMemberCtx` refuses the request when
 * the session is not live or the caller is not a member.
 */
export async function getMemberAccess(
  tx: Tx,
  s: { agencyId: string; userId: string; impersonationId?: string },
): Promise<{ role: impRepo.MemberRole | null; live: boolean }> {
  return impRepo.findMemberAccess(tx, s);
}

/**
 * Before an impersonated request's own transaction (S1-09 review, S1-F9; one read since S2-F1): the staff
 * member is still active staff with a role that may impersonate, and their login is ACTIVE with the session
 * version the token was minted for (a password reset, 2FA change or "sign out everywhere" bumps it). One
 * `app_auth` read scoped to the staff member (`app_staff` cannot read `users`), so withdrawing or
 * downgrading staff access ends impersonation on the next call.
 */
export async function isImpersonatorCurrent(staffUserId: string, sessionVersion: number): Promise<boolean> {
  if (!UUID.test(staffUserId)) return false; // a malformed claim ends the session, never a 500
  return withAuth({ userId: staffUserId }, async (tx) => {
    const login = await repo.findImpersonatorLogin(tx, staffUserId);
    return (
      login !== null &&
      login.status === 'ACTIVE' &&
      login.sessionVersion === sessionVersion &&
      IMPERSONATING_ROLES.includes(login.role)
    );
  });
}

/**
 * `pnpm staff:revoke` (`withSystem`): a revoked staff member's open session ends with their access.
 * Audited per session under its agency.
 */
export async function endImpersonationsOf(tx: Tx, staffUserId: string): Promise<number> {
  const ended = await impRepo.endOpenSessions(tx, staffUserId);
  for (const s of ended) {
    await compliance.auditSystem(tx, {
      type: 'staff.impersonation.ended',
      agencyId: s.agencyId,
      target: null,
      metadata: { impersonationId: s.id, staffUserId, cause: 'staffRevoked' },
    });
  }
  return ended.length;
}
