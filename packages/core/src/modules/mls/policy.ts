import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in mls (PATTERNS §6). Deny by default; services call `assertCan`. */
export const MLS_ACTIONS = [
  /** The agency's client registrations (with the clients it registered) and the ones received for its targets. */
  'mls.registrations.read',
  /** Register one of the agency's contacts for another agency's listing or development (S11-01). */
  'mls.registrations.write',
  /** The agency's viewing requests, as introducer and as owner, with their terms (S11-02). */
  'mls.viewings.read',
  /** Request a viewing for a registered client, answer one (accept and with it the terms, decline, reschedule), cancel, record the outcome. */
  'mls.viewings.write',
] as const;
export type MlsAction = (typeof MLS_ACTIONS)[number];

/** Client Mode (PATTERNS §6) is read-only — and registrations and viewing terms name clients, partners and commission: nothing is open. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<MlsAction> = new Set<MlsAction>();

/** Staff impersonating a member (S1-09) may look at registrations to diagnose a problem, never register a client. */
export const MLS_IMPERSONATION: ImpersonationRules<MlsAction> = {
  'mls.registrations.read': 'allowed',
  'mls.registrations.write': 'forbidden',
  'mls.viewings.read': 'allowed',
  // accepting binds the agency to commission terms: never on someone else's behalf
  'mls.viewings.write': 'forbidden',
};

/** Members who work clients (a `PARTNER` membership does not). */
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: MlsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, MLS_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  switch (action) {
    case 'mls.registrations.read':
    case 'mls.viewings.read':
      return MEMBER_ROLES.has(ctx.actor.role);
    case 'mls.registrations.write':
    case 'mls.viewings.write':
      // the network is for verified agencies (PLAN §3): an unverified one cannot register clients on it
      return MEMBER_ROLES.has(ctx.actor.role) && ctx.tenant.verified;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
