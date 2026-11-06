import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';
import * as crm from '../crm';

/** Who may do what in matching (PATTERNS §6). Deny by default; services call `assertCan`. */
export const MATCHING_ACTIONS = [
  /** S5-06: the member's own saved searches — read, create, change, delete. */
  'matching.savedSearches.manage',
  /**
   * R2-02a: a contact's client profiles — read. The contact's own rule (`crm.contacts.read`): whoever may read the
   * contact may read its profiles; the service also checks the contact is an open contact of the agency.
   */
  'matching.clientProfiles.read',
  /** R2-02a: create, change and delete a contact's client profiles — the contact's write rule (`crm.contacts.write`). */
  'matching.clientProfiles.write',
] as const;
export type MatchingAction = (typeof MATCHING_ACTIONS)[number];

/**
 * Client Mode (PATTERNS §6) is read-only, a saved search is the agent's own work tool and a client profile is internal
 * client data (wishes, budget): none of it is shown.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<MatchingAction> = new Set<MatchingAction>();

/**
 * Staff impersonating a member (S1-09) never change the member's saved searches (their alerts go to the member). R2-02a:
 * nor read or change client profiles — a client's wishes and budget are not needed to diagnose the dashboard.
 */
export const MATCHING_IMPERSONATION: ImpersonationRules<MatchingAction> = {
  'matching.savedSearches.manage': 'forbidden',
  'matching.clientProfiles.read': 'forbidden',
  'matching.clientProfiles.write': 'forbidden',
};

/** Members who work clients and stock (a `PARTNER` membership does not). */
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: MatchingAction): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, MATCHING_IMPERSONATION, action)) return false;
  if (!MEMBER_ROLES.has(ctx.actor.role)) return false;
  switch (action) {
    case 'matching.savedSearches.manage':
      return true;
    // the owning contact's rule: an agent who may not see / change the contact may not see / change its profiles
    case 'matching.clientProfiles.read':
      return crm.can(ctx, 'crm.contacts.read');
    case 'matching.clientProfiles.write':
      return crm.can(ctx, 'crm.contacts.write');
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
