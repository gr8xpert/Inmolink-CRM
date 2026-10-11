import type { InvitableRole } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/**
 * Identity rules (PATTERNS §6). Auth flows have no actor yet, so `loginDecision` and
 * `canIssueAccessToken` take the user row instead of `ctx`. Team management uses `can(ctx, …)`.
 */
export interface LoginSubject {
  status: string;
  emailVerifiedAt: Date | null;
}

export type LoginDecision = 'ok' | 'invalid' | 'unverified';

/**
 * After the password matched. Disabled accounts and deactivated members look like a wrong password
 * (no account probing).
 */
export function loginDecision(user: LoginSubject, member?: { deactivatedAt: Date | null } | null): LoginDecision {
  if (user.status !== 'ACTIVE' || member?.deactivatedAt) return 'invalid';
  if (!user.emailVerifiedAt) return 'unverified';
  return 'ok';
}

/**
 * An access token is minted only for an active, verified user whose session was not revoked and who
 * was not deactivated by their agency.
 */
export function canIssueAccessToken(
  user: LoginSubject & { sessionVersion: number },
  sessionVersion: number,
  member?: { deactivatedAt: Date | null } | null,
): boolean {
  return loginDecision(user, member) === 'ok' && user.sessionVersion === sessionVersion;
}

/**
 * Second factor (S1-04, PLAN §3 #30 §12): required for staff and for agency admins (the admin role of
 * either family: they manage members, keys and billing). Other roles may opt in.
 */
const MFA_REQUIRED_ROLES: readonly string[] = ['AGENCY_ADMIN', 'DEVELOPER_ADMIN'];

export function requiresSecondFactor(
  member: { role: string; deactivatedAt: Date | null } | null,
  isStaff: boolean,
): boolean {
  return isStaff || (member !== null && !member.deactivatedAt && MFA_REQUIRED_ROLES.includes(member.role));
}

/**
 * Whether a session must have passed the second factor before it gets an access token: always when 2FA
 * is enabled (opted in or not), and when the role requires it — then a session without it must enrol.
 */
export function sessionNeedsSecondFactor(subject: { enrolled: boolean; required: boolean }): boolean {
  return subject.enrolled || subject.required;
}

export type IdentityAction = 'identity.members.read' | 'identity.members.manage';

/**
 * Admins hand out the roles of their own family (PLAN §3 #2): an agency admin manages agency admins
 * and agents, a developer admin the developer roles. Every other role manages nobody.
 */
const MANAGED_ROLES: Record<string, readonly InvitableRole[]> = {
  AGENCY_ADMIN: ['AGENCY_ADMIN', 'AGENT'],
  DEVELOPER_ADMIN: ['DEVELOPER_ADMIN', 'DEVELOPER_AGENT'],
};

export function can(
  ctx: Ctx,
  action: IdentityAction,
  resource: { agencyId?: string; userId?: string; role?: string } = {},
): boolean {
  if (ctx.actor.kind !== 'user') return false;
  const sameAgency = resource.agencyId === undefined || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'identity.members.read':
      return sameAgency;
    case 'identity.members.manage': {
      // Client Mode is read-only (PATTERNS §6); nobody changes their own membership.
      if (!sameAgency || ctx.clientMode || resource.userId === ctx.actor.userId) return false;
      const managed = MANAGED_ROLES[ctx.actor.role];
      if (!managed) return false;
      return resource.role === undefined || (managed as readonly string[]).includes(resource.role);
    }
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
