import { SUPPORT_AGENT_ROLES } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, StaffCtx, StaffRole } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/**
 * Who may do what in support (S13-05, PATTERNS §6). Deny by default; services call `assertCan` / `assertStaffCan`.
 * Every member of an agency reads and opens its tickets (support is for everyone, not only admins). Client Mode
 * reaches nothing here: a ticket is the agency's own business, not something to show a client.
 */
export const SUPPORT_ACTIONS = ['support.read', 'support.write'] as const;
export type SupportAction = (typeof SUPPORT_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and support is not part of it at all. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<SupportAction> = new Set<SupportAction>();

/**
 * Staff impersonating a member (S1-09, S17-F47) may read the agency's tickets and open their attachments to diagnose a
 * problem, as in chat. They never write in the member's name: a ticket, reply, attachment or "resolved" would read as
 * the member's own, and reach the support inbox as such. Staff answer from the console (`postStaffMessage`,
 * `updateStaffTicket`), signed as support and audited as `staff.support.*`. Each read leaves a
 * `support.clientData.read` row: a ticket can hold client details and the member's own words.
 */
export const SUPPORT_IMPERSONATION: ImpersonationRules<SupportAction> = {
  'support.read': 'allowed',
  'support.write': 'forbidden',
};

export function can(ctx: Ctx, action: SupportAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, SUPPORT_IMPERSONATION, action)) return false;
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

const SUPPORT_AGENTS: ReadonlySet<StaffRole> = new Set(SUPPORT_AGENT_ROLES);

export function canStaff(ctx: StaffCtx, action: StaffSupportAction): boolean {
  if (ctx.actor.kind !== 'staff') return false;
  switch (action) {
    case 'staff.support.read':
      return true;
    case 'staff.support.write':
      return SUPPORT_AGENTS.has(ctx.actor.role);
  }
}

export function assertStaffCan(...args: Parameters<typeof canStaff>): void {
  if (!canStaff(...args)) throw new AppError('FORBIDDEN');
}
