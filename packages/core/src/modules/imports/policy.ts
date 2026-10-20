import { IMPORT_RESUME_STAFF_ROLES } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what with feed imports (PATTERNS §6). Deny by default; services call `assertCan`. */
export const IMPORTS_ACTIONS = [
  /** Connections (never their credentials), run history and per-item errors. */
  'imports.read',
  /** Create, change (URL, credentials, schedule, on/off) and delete connections. */
  'imports.manage',
  /** Start a run now. */
  'imports.run',
] as const;
export type ImportsAction = (typeof IMPORTS_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and imports are internal: nothing is open in Client Mode. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<ImportsAction> = new Set<ImportsAction>();

/**
 * Staff impersonating a member (S1-09): they may look at runs and start one to diagnose a feed, never change a
 * connection (its URL and credentials are the agency's).
 */
export const IMPORTS_IMPERSONATION: ImpersonationRules<ImportsAction> = {
  'imports.read': 'allowed',
  'imports.manage': 'forbidden',
  'imports.run': 'allowed',
};

/** Feeds write the agency's listings: its admins set them up; agents may follow and re-run them. */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: ImportsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, IMPORTS_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  const { role } = ctx.actor;
  switch (action) {
    case 'imports.read':
    case 'imports.run':
      return MEMBER_ROLES.has(role);
    case 'imports.manage':
      return ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * Staff actions on imports (S6-08): every staff role reads the import health dashboard; resuming a connection the
 * anomaly guard paused (it lets a feed write or withdraw an agency's listings again) is data ops and super admin work.
 */
export type StaffImportsAction = 'staff.imports.read' | 'staff.imports.resume';

const IMPORT_RESUMERS: ReadonlySet<string> = new Set(IMPORT_RESUME_STAFF_ROLES);

export function canStaff(ctx: StaffCtx, action: StaffImportsAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.imports.read':
      return true;
    case 'staff.imports.resume':
      return IMPORT_RESUMERS.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
