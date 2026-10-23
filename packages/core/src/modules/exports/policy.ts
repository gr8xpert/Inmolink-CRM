import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what with the agency's portal connections (PATTERNS §6). Deny by default; services call `assertCan`. */
export const EXPORTS_ACTIONS = [
  /** The portal catalog, the agency's connections and their selection. */
  'exports.read',
  /** Create and change connections, their tokens, credentials and per-property choices. */
  'exports.manage',
] as const;
export type ExportsAction = (typeof EXPORTS_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6) — and portal setup is internal: nothing is open in Client Mode. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<ExportsAction> = new Set<ExportsAction>();

/** Staff impersonating a member (S1-09) may look at the setup to diagnose a feed, never change what it publishes. */
export const EXPORTS_IMPERSONATION: ImpersonationRules<ExportsAction> = {
  'exports.read': 'allowed',
  'exports.manage': 'forbidden',
};

/** A connection decides what the agency publishes to a portal (and holds its credentials): admins set it up. */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: ExportsAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, EXPORTS_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  const { role } = ctx.actor;
  switch (action) {
    case 'exports.read':
      return MEMBER_ROLES.has(role);
    case 'exports.manage':
      return ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
