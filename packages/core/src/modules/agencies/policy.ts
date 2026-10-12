import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';

/** Who may do what in agencies (PATTERNS §6). Deny by default; services call `assertCan`. */
export type AgenciesAction =
  | 'agencies.read'
  | 'agencies.updateDetails'
  | 'agencies.verification.read'
  | 'agencies.verification.manage'
  | 'agencies.profile.update'
  | 'agencies.settings.update'
  | 'agencies.settings.read'
  | 'agencies.commission.read';

/** Roles that administer their agency (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: AgenciesAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'agencies.read':
      return sameAgency;
    case 'agencies.settings.read':
    case 'agencies.commission.read':
      // Commission and the Client Mode PIN policy are never shown to a client (PLAN §3 #56).
      return sameAgency && !ctx.clientMode;
    case 'agencies.updateDetails':
    case 'agencies.verification.manage':
    case 'agencies.profile.update':
      // Client Mode is read-only (PATTERNS §6). Staff impersonating an admin may fix the profile
      // (logo, contact); the event records both of them.
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
    case 'agencies.settings.update':
      // Settings carry commission terms and the Client Mode PIN policy: the agency's own admins decide
      // them, never staff impersonating one (like API keys and 2FA, `.claude/rules/security.md`).
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role) && ctx.actor.impersonatedBy === undefined;
    case 'agencies.verification.read':
      // Company documents: admins only, never in Client Mode.
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/** Staff actions in agencies (S1-03). Verification is support work; data ops do not decide it. */
export type StaffAgenciesAction = 'staff.verification.read' | 'staff.verification.decide';

const VERIFICATION_STAFF = new Set(['SUPER_ADMIN', 'STAFF_SUPPORT']);

export function canStaff(ctx: StaffCtx, action: StaffAgenciesAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.verification.read':
    case 'staff.verification.decide':
      return VERIFICATION_STAFF.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}

/**
 * What only a VERIFIED agency may do (PLAN §3 #3): share listings with the network or the public
 * (SHARED / PUBLIC visibility) and create website API keys. Listings (S3-02) and API keys (S1-05)
 * call `assertVerified` before writing.
 */
export type VerifiedAction = 'listing.share' | 'listing.publish' | 'apiKey.create';

export function assertVerified(ctx: Ctx, action: VerifiedAction): void {
  if (!ctx.tenant.verified) throw new AppError('VERIFICATION_REQUIRED', { action });
}
