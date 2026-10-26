import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx, StaffRole } from '../../context';

/**
 * Who may do what in support (S13-05, PATTERNS §6). Deny by default; services call `assertCan` / `assertStaffCan`.
 * Every member of an agency reads and opens its tickets (support is for everyone, not only admins). Client Mode
 * reaches nothing here: a ticket is the agency's own business, not something to show a client.
 */
export const SUPPORT_ACTIONS = ['support.read', 'support.write'] as const;
export type SupportAction = (typeof SUPPORT_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and support is not part of it at all. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<SupportAction> = new Set<SupportAction>();

export function can(ctx: Ctx, action: SupportAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'support.read':
    case 'support.write':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * Staff side: every staff role reads the queue; support staff and super admins reply, keep internal notes and triage
 * (RLS repeats the rule: registry `SUPPORT_AGENT`).
 */
export type StaffSupportAction = 'staff.support.read' | 'staff.support.write';

export const SUPPORT_AGENT_ROLES: ReadonlySet<StaffRole> = new Set<StaffRole>(['SUPER_ADMIN', 'STAFF_SUPPORT']);

export function canStaff(ctx: StaffCtx, action: StaffSupportAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.support.read':
      return true;
    case 'staff.support.write':
      return SUPPORT_AGENT_ROLES.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
