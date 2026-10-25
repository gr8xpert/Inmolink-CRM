import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what in ai-features (PATTERNS §6). Deny by default; services call `assertCan`. */
export const AI_FEATURES_ACTIONS = [
  'aiFeatures.read',
  /** S12-02: ask the Listing Studio for drafts (the listing's own `listing.update` rule is checked by properties). */
  'aiFeatures.listingStudio',
] as const;
export type AiFeaturesAction = (typeof AI_FEATURES_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<AiFeaturesAction> = new Set<AiFeaturesAction>(['aiFeatures.read']);

/** Staff impersonating a member (S1-09) do not spend the agency's AI budget. */
export const AI_FEATURES_IMPERSONATION: ImpersonationRules<AiFeaturesAction> = {
  'aiFeatures.read': 'allowed',
  'aiFeatures.listingStudio': 'forbidden',
};

/** Roles that write listings (PLAN §3 #2); PARTNER members only read. */
const LISTING_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: AiFeaturesAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, AI_FEATURES_IMPERSONATION, action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'aiFeatures.read':
      return sameAgency;
    case 'aiFeatures.listingStudio':
      return sameAgency && LISTING_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
