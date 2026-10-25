import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/**
 * Who may do what in presentations (PATTERNS §6). Deny by default; services call `assertCan`. Selections name a CRM
 * contact and carry what the client did: the agency's members who work clients (the CRM's roles), never Client Mode.
 */
export const PRESENTATIONS_ACTIONS = [
  /** The agency's selections, their items, stats and the client's interactions. */
  'presentations.read',
  /** Make, change, re-link and stop selections. */
  'presentations.write',
] as const;
export type PresentationsAction = (typeof PRESENTATIONS_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and a selection names its client and what they did: none is open. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<PresentationsAction> = new Set<PresentationsAction>([]);

/**
 * Staff impersonating a member (S1-09) may look at selections to diagnose a problem (like the CRM's contacts and
 * timeline), never make one or mint a link — a link is a credential to a client's page.
 */
export const PRESENTATIONS_IMPERSONATION: ImpersonationRules<PresentationsAction> = {
  'presentations.read': 'allowed',
  'presentations.write': 'forbidden',
};

/** Members who work clients — the CRM's (`crm` policy): a `PARTNER` membership does not. */
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: PresentationsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, PRESENTATIONS_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  switch (action) {
    case 'presentations.read':
    case 'presentations.write':
      return MEMBER_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
