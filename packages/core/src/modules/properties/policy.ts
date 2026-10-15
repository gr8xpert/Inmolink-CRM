import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what with listings (PATTERNS §6). Deny by default; services call `assertCan`. */
export const PROPERTIES_ACTIONS = [
  'listing.read',
  'listing.create',
  'listing.update',
  'listing.delete',
  'listing.restore',
  /** Visibility or share scope (who outside the agency sees it). */
  'listing.publish',
  /** Make another member the listing's owner. */
  'listing.assign',
] as const;
export type PropertiesAction = (typeof PROPERTIES_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<PropertiesAction> = new Set<PropertiesAction>(['listing.read']);

/**
 * Staff impersonating a member (S1-09, S3-02 decision): they may read listings and create or fix their data for
 * the agency (each request is traced with both ids); never change the deal (commission, split) or the status
 * (`updateListing` refuses those fields), delete or restore one, change who sees it outside the agency, or
 * hand it to another member.
 */
export const PROPERTIES_IMPERSONATION: ImpersonationRules<PropertiesAction> = {
  'listing.read': 'allowed',
  'listing.create': 'allowed',
  'listing.update': 'allowed',
  'listing.delete': 'forbidden',
  'listing.restore': 'forbidden',
  'listing.publish': 'forbidden',
  'listing.assign': 'forbidden',
};

/** Roles that administer their agency's listings (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
/** Roles that list properties; PARTNER members only read. */
const LISTING_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export type ListingResource = { agencyId: string; ownerUserId: string };

export function can(ctx: Ctx, action: PropertiesAction, listing?: ListingResource): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, PROPERTIES_IMPERSONATION, action)) return false;
  const { role, userId } = ctx.actor;
  const sameAgency = !listing || listing.agencyId === ctx.tenant.agencyId;
  // Only the owner agency writes (other agencies read shared listings through RLS, never write them).
  const writer = sameAgency && LISTING_ROLES.has(role);
  const ownOrAdmin = ADMIN_ROLES.has(role) || !listing || listing.ownerUserId === userId;
  switch (action) {
    case 'listing.read':
      return true; // RLS decides which listings are visible; the service picks the view
    case 'listing.create':
      return writer;
    case 'listing.update':
    case 'listing.delete':
    case 'listing.restore':
    case 'listing.publish':
      return writer && ownOrAdmin;
    case 'listing.assign':
      return writer && ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
