import { STAFF_OPERATION_ROLES } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx, StaffRole } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/**
 * Who may do what in dedupe (PATTERNS §6). Deny by default; services call `assertCan` / `assertStaffCan`.
 *
 * R2-03b: members who work stock (not `PARTNER`) read the agency's duplicate review queue, clustered listings and
 * disputes; deciding a pair and disputing a clustering change how the agency's listings reach clients (one listing per
 * cluster), so they are the agency admins' — the same people who decide who sees a listing outside the agency.
 */
export const DEDUPE_ACTIONS = ['dedupe.read', 'dedupe.review', 'dedupe.dispute'] as const;
export type DedupeAction = (typeof DEDUPE_ACTIONS)[number];

/**
 * Client Mode is read-only (PATTERNS §6) — and shows none of this: the duplicate views are internal (which other
 * agencies list the same property).
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<DedupeAction> = new Set<DedupeAction>();

/** Staff impersonating a member read the views to diagnose them; they never decide or dispute in the agency's name. */
export const DEDUPE_IMPERSONATION: ImpersonationRules<DedupeAction> = {
  'dedupe.read': 'allowed',
  'dedupe.review': 'forbidden',
  'dedupe.dispute': 'forbidden',
};

const STOCK_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: DedupeAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, DEDUPE_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  switch (action) {
    case 'dedupe.read':
      return STOCK_ROLES.has(ctx.actor.role);
    case 'dedupe.review':
    case 'dedupe.dispute':
      return ADMIN_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * Staff side (R2-03b): every staff role reads the dispute queue; data ops and super admins resolve disputes (RLS
 * repeats the rule: registry `STAFF_OPERATOR` on `dedupe_disputes` and the outbox).
 */
export type StaffDedupeAction = 'staff.dedupe.read' | 'staff.dedupe.resolve';

const RESOLVERS: ReadonlySet<StaffRole> = new Set(STAFF_OPERATION_ROLES);

export function canStaff(ctx: StaffCtx, action: StaffDedupeAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.dedupe.read':
      return true;
    case 'staff.dedupe.resolve':
      return RESOLVERS.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
