import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in compliance (PATTERNS §6). Deny by default; services call `assertCan`. */
export const COMPLIANCE_ACTIONS = [
  'compliance.auditLog.read',
  'compliance.dataExport.create',
  'compliance.dataExport.read',
  'compliance.dataExport.download',
  'compliance.consents.read',
  'compliance.retention.read',
  'compliance.retention.manage',
] as const;
export type ComplianceAction = (typeof COMPLIANCE_ACTIONS)[number];

/**
 * Staff impersonating an admin may read the agency's log (S1-09) and see its exports' status (S10-08), but never
 * export or download the agency's data: a bulk copy of client PII is the agency's own act.
 */
export const COMPLIANCE_IMPERSONATION: ImpersonationRules<ComplianceAction> = {
  'compliance.auditLog.read': 'allowed',
  'compliance.dataExport.create': 'forbidden',
  'compliance.dataExport.read': 'allowed',
  'compliance.dataExport.download': 'forbidden',
  'compliance.consents.read': 'allowed',
  'compliance.retention.read': 'allowed',
  // S16-04: a retention period decides which clients are erased for good — the agency's own act.
  'compliance.retention.manage': 'forbidden',
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
    case 'compliance.dataExport.create':
    case 'compliance.dataExport.read':
    case 'compliance.dataExport.download':
      // S10-08: an export is every contact, lead and listing of the agency (client PII, commissions): its admins
      // only, never in Client Mode (a screen shown to a buyer).
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
    case 'compliance.consents.read':
      // S16-04: a contact's consent history (ids, purposes, times). The caller (crm) has already checked the member
      // may read the contact; never in Client Mode.
      return sameAgency && !ctx.clientMode;
    case 'compliance.retention.read':
    case 'compliance.retention.manage':
      // S16-04: how long inactive clients are kept — the agency's admins.
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
