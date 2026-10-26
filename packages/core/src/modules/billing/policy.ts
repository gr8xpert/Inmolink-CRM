import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in billing (PATTERNS §6). Deny by default; services call `assertCan`. */
export const BILLING_ACTIONS = ['billing.read', 'billing.manage'] as const;
export type BillingAction = (typeof BILLING_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and the plan, prices and invoices are not part of it at all. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<BillingAction> = new Set<BillingAction>();

/** Staff impersonating a member (S1-09) may see the plan, never change plans, payment methods or invoices. */
export const BILLING_IMPERSONATION: ImpersonationRules<BillingAction> = {
  'billing.read': 'allowed',
  'billing.manage': 'forbidden',
};

/** Roles that administer their agency (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: BillingAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, BILLING_IMPERSONATION, action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'billing.read':
      // S12-06 review: the plan and its prices are internal — never shown to a client at the screen. S13-01: nor to
      // partners (outside the agency's staff).
      return sameAgency && !ctx.clientMode && ctx.actor.role !== 'PARTNER';
    case 'billing.manage':
      // Plans, payment methods and invoices (S13): the agency's own admins, never in Client Mode. Every
      // billing write must check this action.
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * S13-02: staff billing actions. Plan grants and price locks give away revenue: super admins only (support asks them;
 * the staff console lists grants for every staff role).
 */
export type StaffBillingAction = 'staff.billing.read' | 'staff.billing.grant';

export function canStaff(ctx: StaffCtx, action: StaffBillingAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.billing.read':
      return true;
    case 'staff.billing.grant':
      return ctx.actor.role === 'SUPER_ADMIN';
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
