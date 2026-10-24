import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in crm (PATTERNS §6). Deny by default; services call `assertCan`. */
export const CRM_ACTIONS = [
  /** Contacts, their notes and the agency's contact imports. */
  'crm.contacts.read',
  /** Create and change contacts, add notes. */
  'crm.contacts.write',
  /** Merge two contacts (one is closed, everything pointing at it moves to the other). */
  'crm.contacts.merge',
  /** Import a CSV / Excel file of contacts. */
  'crm.contacts.import',
  /** The lead inbox and the introductions to the agency's own listings (S10-02). */
  'crm.leads.read',
  /** Enter leads, change their status and assignment. */
  'crm.leads.write',
  /** The agency's lead assignment rule (round robin, owner agent). */
  'crm.leads.routing',
  /** The agency's pipeline stages: add, rename, reorder, archive (S10-03; reading them and the board is `leads.read`). */
  'crm.pipeline.manage',
  /** The activity timeline of a contact, lead or listing, and the agency's feed (S10-04). */
  'crm.activities.read',
  /** Log a call, e-mail, meeting or viewing. */
  'crm.activities.write',
  /** Tasks and reminders (S10-05): see every task of the agency. */
  'crm.tasks.read',
  /** Create, change, complete and delete tasks. */
  'crm.tasks.write',
] as const;
export type CrmAction = (typeof CRM_ACTIONS)[number];

/**
 * Client Mode (PATTERNS §6) is read-only — and contacts and leads are other clients' personal data and the agency's
 * owner contacts: nothing of the CRM is open in Client Mode.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<CrmAction> = new Set<CrmAction>();

/** Staff impersonating a member (S1-09) may look at contacts to diagnose a problem, never change or merge them. */
export const CRM_IMPERSONATION: ImpersonationRules<CrmAction> = {
  'crm.contacts.read': 'allowed',
  'crm.contacts.write': 'forbidden',
  'crm.contacts.merge': 'forbidden',
  'crm.contacts.import': 'forbidden',
  'crm.leads.read': 'allowed',
  'crm.leads.write': 'forbidden',
  'crm.leads.routing': 'forbidden',
  'crm.pipeline.manage': 'forbidden',
  'crm.activities.read': 'allowed',
  'crm.activities.write': 'forbidden',
  'crm.tasks.read': 'allowed',
  'crm.tasks.write': 'forbidden',
};

const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
/** Members who work clients (a `PARTNER` membership does not). */
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: CrmAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, CRM_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  const { role } = ctx.actor;
  switch (action) {
    case 'crm.contacts.read':
    case 'crm.contacts.write':
    case 'crm.contacts.merge':
    case 'crm.leads.read':
    case 'crm.leads.write':
    case 'crm.activities.read':
    case 'crm.activities.write':
    case 'crm.tasks.read':
    case 'crm.tasks.write':
      return MEMBER_ROLES.has(role);
    case 'crm.contacts.import':
    case 'crm.leads.routing':
    case 'crm.pipeline.manage':
      return ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
