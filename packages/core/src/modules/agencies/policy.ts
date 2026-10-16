import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in agencies (PATTERNS §6). Deny by default; services call `assertCan`. */
export const AGENCIES_ACTIONS = [
  'agencies.read',
  'agencies.updateDetails',
  'agencies.verification.read',
  'agencies.verification.manage',
  'agencies.profile.update',
  'agencies.settings.update',
  'agencies.settings.read',
  'agencies.commission.read',
  'agencies.preferred.read',
  'agencies.preferred.add',
  'agencies.preferred.manage',
  'agencies.directory.search',
] as const;
export type AgenciesAction = (typeof AGENCIES_ACTIONS)[number];

/**
 * Staff impersonating a member (S1-09): they may read and fix the profile and notes (recorded with both
 * names); never change the verified identity (details, verification), settings (commission, PIN policy) or
 * who sees PREFERRED listings. Removing a preferred agency only narrows access, so it stays allowed.
 * Reading settings, commission and split stays allowed (S2-F2 decision): support must see what the member
 * sees to help, these are the agency's own terms (not billing secrets or 2FA), and every impersonated
 * request is traced with both names (request log); Client Mode still hides them.
 */
export const AGENCIES_IMPERSONATION: ImpersonationRules<AgenciesAction> = {
  'agencies.read': 'allowed',
  'agencies.updateDetails': 'forbidden',
  'agencies.verification.read': 'allowed',
  'agencies.verification.manage': 'forbidden',
  'agencies.profile.update': 'allowed',
  'agencies.settings.update': 'forbidden',
  'agencies.settings.read': 'allowed',
  'agencies.commission.read': 'allowed',
  'agencies.preferred.read': 'allowed',
  'agencies.preferred.add': 'forbidden',
  'agencies.preferred.manage': 'allowed',
  'agencies.directory.search': 'allowed',
};

/** Roles that administer their agency (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: AgenciesAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (deniedByImpersonation(ctx, AGENCIES_IMPERSONATION, action)) return false;
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
    case 'agencies.settings.update':
    case 'agencies.preferred.add':
    case 'agencies.preferred.manage':
    case 'agencies.verification.read':
      // Admins only, never in Client Mode (read-only, PATTERNS §6).
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
    case 'agencies.preferred.read':
    case 'agencies.directory.search':
      // Members see whom their agency trusts (they choose PREFERRED sharing on listings); the list and
      // its internal notes are never shown to a client.
      return sameAgency && !ctx.clientMode;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * Staff actions in agencies (S1-03, S1-09). Verification is support work; data ops do not decide it.
 * Every staff role reads the tenants list and a tenant's company details (the console's starting point).
 */
export type StaffAgenciesAction = 'staff.verification.read' | 'staff.verification.decide' | 'staff.tenants.read';

const VERIFICATION_STAFF = new Set(['SUPER_ADMIN', 'STAFF_SUPPORT']);

export function canStaff(ctx: StaffCtx, action: StaffAgenciesAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.verification.read':
    case 'staff.verification.decide':
      return VERIFICATION_STAFF.has(ctx.actor.role);
    case 'staff.tenants.read':
      return true;
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}

/**
 * What only a VERIFIED agency may do (PLAN §3 #3): share listings with the network or the public
 * (SHARED / PUBLIC visibility) and create website API keys. Listings (S3-02) and API keys (S1-05)
 * call `assertVerified` before writing; preferred agencies (S1-07) before adding one or searching the
 * directory (only verified agencies take part in the network).
 */
export type VerifiedAction =
  | 'listing.share'
  | 'listing.publish'
  | 'apiKey.create'
  | 'preferredAgency.add'
  | 'directory.search'
  | 'development.share';

export function assertVerified(ctx: Ctx, action: VerifiedAction): void {
  if (!ctx.tenant.verified) throw new AppError('VERIFICATION_REQUIRED', { action });
}
