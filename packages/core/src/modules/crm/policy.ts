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
] as const;
export type CrmAction = (typeof CRM_ACTIONS)[number];

/**
 * Client Mode (PATTERNS §6) is read-only — and contacts are other clients' personal data and the agency's owner
 * contacts: nothing of the CRM is open in Client Mode.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<CrmAction> = new Set<CrmAction>();

/** Staff impersonating a member (S1-09) may look at contacts to diagnose a problem, never change or merge them. */
export const CRM_IMPERSONATION: ImpersonationRules<CrmAction> = {
  'crm.contacts.read': 'allowed',
  'crm.contacts.write': 'forbidden',
  'crm.contacts.merge': 'forbidden',
  'crm.contacts.import': 'forbidden',
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
      return MEMBER_ROLES.has(role);
    case 'crm.contacts.import':
      return ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
