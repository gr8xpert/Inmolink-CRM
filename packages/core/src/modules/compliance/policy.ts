import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in compliance (PATTERNS §6). Deny by default; services call `assertCan`. */
export const COMPLIANCE_ACTIONS = ['compliance.auditLog.read'] as const;
export type ComplianceAction = (typeof COMPLIANCE_ACTIONS)[number];

/** Staff impersonating an admin may read the agency's log (S1-09). */
export const COMPLIANCE_IMPERSONATION: ImpersonationRules<ComplianceAction> = {
  'compliance.auditLog.read': 'allowed',
};

/** Roles that administer their agency (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: ComplianceAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (deniedByImpersonation(ctx, COMPLIANCE_IMPERSONATION, action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'compliance.auditLog.read':
      // Who logged in, changed roles and keys: the agency's admins, never in Client Mode. Staff
      // impersonating an admin may read it (read-only); staff read every log with `staff.auditLog.read`.
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/** Staff actions in compliance (S1-09): the cross-agency audit viewer is for super admins and support. */
export type StaffComplianceAction = 'staff.auditLog.read';

const AUDIT_STAFF: readonly string[] = ['SUPER_ADMIN', 'STAFF_SUPPORT'];

export function canStaff(ctx: StaffCtx, action: StaffComplianceAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.auditLog.read':
      return AUDIT_STAFF.includes(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
