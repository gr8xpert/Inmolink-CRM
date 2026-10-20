import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what with the agency's websites (PATTERNS §6). Deny by default; services call `assertCan`. */
export const WEBSITES_ACTIONS = [
  /** The agency's sites: policy, prefix, locales, contact overrides. */
  'websites.read',
  /** Create and change sites. */
  'websites.manage',
] as const;
export type WebsitesAction = (typeof WEBSITES_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and site setup is internal: nothing is open in Client Mode. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<WebsitesAction> = new Set<WebsitesAction>();

/**
 * Staff impersonating a member (S1-09) may look at a site's setup to diagnose a website, never change what it
 * publishes.
 */
export const WEBSITES_IMPERSONATION: ImpersonationRules<WebsitesAction> = {
  'websites.read': 'allowed',
  'websites.manage': 'forbidden',
};

/** A site decides what the agency publishes (and its keys, S1-05): admins set it up; agents may look. */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: WebsitesAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, WEBSITES_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  const { role } = ctx.actor;
  switch (action) {
    case 'websites.read':
      return MEMBER_ROLES.has(role);
    case 'websites.manage':
      return ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
