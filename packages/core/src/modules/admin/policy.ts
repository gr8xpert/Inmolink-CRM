import { STAFF_OPERATION_ROLES, type StaffRole, SUPER_ADMIN_ROLES } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { StaffCtx } from '../../context';

/**
 * Who may do what in the staff console's operations (S13-03, PATTERNS §6). Deny by default; services call
 * `assertStaffCan`. Every staff role reads (operations, flags, queue health, AI spend); bulk operations are run and
 * cancelled by data ops and super admins; feature flags and plan grants change only for super admins (billing checks
 * grants itself). RLS repeats each rule from the same contracts role set (registry `STAFF_OPERATOR`, `SUPER_ADMIN`).
 */
export type AdminAction = 'staff.admin.read' | 'staff.admin.runOperation' | 'staff.admin.setFlag';

const OPERATORS: ReadonlySet<StaffRole> = new Set(STAFF_OPERATION_ROLES);
const FLAG_SETTERS: ReadonlySet<StaffRole> = new Set(SUPER_ADMIN_ROLES);

export function canStaff(ctx: StaffCtx, action: AdminAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.admin.read':
      return true;
    case 'staff.admin.runOperation':
      return OPERATORS.has(ctx.actor.role);
    case 'staff.admin.setFlag':
      return FLAG_SETTERS.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
