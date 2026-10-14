import type { InvitableRole } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

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

export const IDENTITY_ACTIONS = [
  'identity.members.read',
  'identity.members.manage',
  'identity.apiKeys.read',
  'identity.apiKeys.manage',
  'identity.staffAccess.read',
] as const;
export type IdentityAction = (typeof IDENTITY_ACTIONS)[number];

/**
 * Staff impersonating a member (S1-09) see the team and the keys, never change who has access: no
 * invites, role changes, deactivations or invite revocations (an invite to their own email would outlive
 * the session), and no key create, rotate or revoke (keys are credentials).
 */
export const IDENTITY_IMPERSONATION: ImpersonationRules<IdentityAction> = {
  'identity.members.read': 'allowed',
  'identity.members.manage': 'forbidden',
  'identity.apiKeys.read': 'allowed',
  'identity.apiKeys.manage': 'forbidden',
  // The agency's record of staff access (S1-F9): not for the staff member acting as an admin to read.
  'identity.staffAccess.read': 'forbidden',
};

/** Roles that manage the agency's website API keys (S1-05): the admin of either family. */
const API_KEY_ROLES: readonly string[] = ['AGENCY_ADMIN', 'DEVELOPER_ADMIN'];

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
  if (deniedByImpersonation(ctx, IDENTITY_IMPERSONATION, action)) return false;
  const sameAgency = resource.agencyId === undefined || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'identity.members.read':
      // The roster (names, emails, roles) is internal: never shown to a client at the screen.
      return sameAgency && !ctx.clientMode;
    case 'identity.members.manage': {
      // Client Mode is read-only (PATTERNS §6); nobody changes their own membership.
      if (!sameAgency || ctx.clientMode || resource.userId === ctx.actor.userId) return false;
      const managed = MANAGED_ROLES[ctx.actor.role];
      if (!managed) return false;
      return resource.role === undefined || (managed as readonly string[]).includes(resource.role);
    }
    case 'identity.staffAccess.read':
      // Transparency for the agency: its admins see when staff acted as a member, and the stated reason.
      return sameAgency && !ctx.clientMode && API_KEY_ROLES.includes(ctx.actor.role);
    case 'identity.apiKeys.read':
    case 'identity.apiKeys.manage':
      // Keys expose the agency's inventory to websites: admins only, never in Client Mode.
      return sameAgency && !ctx.clientMode && API_KEY_ROLES.includes(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * Staff actions in identity (S1-09). Members' names and emails, and acting as one of them (impersonation,
 * PLAN §12), are support work: super admins and support, not data ops. Guard 0028 repeats the role rule.
 */
export type StaffIdentityAction = 'staff.members.read' | 'staff.impersonate' | 'staff.impersonation.manage';

export const IMPERSONATING_ROLES: readonly string[] = ['SUPER_ADMIN', 'STAFF_SUPPORT'];

export function canStaff(ctx: StaffCtx, action: StaffIdentityAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.impersonation.manage':
      // See and end any staff member's live session (S1-F9): super admins only.
      return ctx.actor.role === 'SUPER_ADMIN';
    case 'staff.members.read':
    case 'staff.impersonate':
      return IMPERSONATING_ROLES.includes(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
