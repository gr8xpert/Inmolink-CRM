import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what on the network board (PATTERNS §6). Deny by default; services call `assertCan`. */
export const NETWORK_ACTIONS = [
  /** The board (open posts of the network and the agency's own) and one post. */
  'network.posts.read',
  /** Post for the agency, reply to another agency's post (a chat thread). Needs a verified agency (the service's). */
  'network.posts.write',
  /** Close a post of the agency: its author or an admin. */
  'network.posts.close',
  /** The member's own subscriptions: read, create, change, delete. */
  'network.subscriptions.manage',
  /** Join one of the agency's reply threads (an admin of the post's agency; repliers join by replying). */
  'network.threads.join',
] as const;
export type NetworkAction = (typeof NETWORK_ACTIONS)[number];

/**
 * Client Mode (PATTERNS §6) is read-only — and the board is between agencies (buyer requests, offers, partners):
 * nothing of it is shown to a client.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<NetworkAction> = new Set<NetworkAction>();

/** Staff impersonating a member (S1-09) may look at the board, never post, reply or change subscriptions for them. */
export const NETWORK_IMPERSONATION: ImpersonationRules<NetworkAction> = {
  'network.posts.read': 'allowed',
  'network.posts.write': 'forbidden',
  'network.posts.close': 'forbidden',
  'network.subscriptions.manage': 'forbidden',
  'network.threads.join': 'forbidden',
};

/** Members who work clients and stock (a `PARTNER` membership does not). */
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(
  ctx: Ctx,
  action: NetworkAction,
  resource?: { agencyId: string; authorUserId?: string | null },
): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, NETWORK_IMPERSONATION, action)) return false;
  if (!MEMBER_ROLES.has(ctx.actor.role)) return false;
  switch (action) {
    case 'network.posts.read':
    case 'network.posts.write':
    case 'network.subscriptions.manage':
      return true;
    case 'network.threads.join':
      return ADMIN_ROLES.has(ctx.actor.role);
    case 'network.posts.close':
      if (!resource || resource.agencyId !== ctx.tenant.agencyId) return false;
      return ADMIN_ROLES.has(ctx.actor.role) || resource.authorUserId === ctx.actor.userId;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
