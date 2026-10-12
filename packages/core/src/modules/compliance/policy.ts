import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/** Who may do what in compliance (PATTERNS §6). Deny by default; services call `assertCan`. */
export type ComplianceAction = 'compliance.auditLog.read';

/** Roles that administer their agency (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: ComplianceAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'compliance.auditLog.read':
      // Who logged in, changed roles and keys: the agency's admins, never in Client Mode. Staff
      // impersonating an admin may read it (read-only; the staff viewer is S1-09).
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
