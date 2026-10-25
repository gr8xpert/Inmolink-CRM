import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in matching (PATTERNS §6). Deny by default; services call `assertCan`. */
export const MATCHING_ACTIONS = [
  /** S5-06: the member's own saved searches — read, create, change, delete. */
  'matching.savedSearches.manage',
] as const;
export type MatchingAction = (typeof MATCHING_ACTIONS)[number];

/** Client Mode (PATTERNS §6) is read-only, and a saved search is the agent's own work tool: none of it is shown. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<MatchingAction> = new Set<MatchingAction>();

/** Staff impersonating a member (S1-09) never change the member's saved searches (their alerts go to the member). */
export const MATCHING_IMPERSONATION: ImpersonationRules<MatchingAction> = {
  'matching.savedSearches.manage': 'forbidden',
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
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
