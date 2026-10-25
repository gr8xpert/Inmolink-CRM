import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';

/** Who may do what with the agency's social accounts and posts (S12-07, PATTERNS §6). Deny by default. */
export const SOCIAL_ACTIONS = [
  /** The connected accounts and the posts' history. */
  'social.read',
  /** Connect and disconnect accounts (they post in the agency's name). */
  'social.manage',
  /** Compose, caption, schedule and cancel posts. */
  'social.post',
] as const;
export type SocialAction = (typeof SOCIAL_ACTIONS)[number];

/** Client Mode is read-only — and the agency's social setup is internal: nothing is open in Client Mode. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<SocialAction> = new Set<SocialAction>();

/** Staff impersonating a member (S1-09) may look at accounts and posts to diagnose, never post or connect for them. */
export const SOCIAL_IMPERSONATION: ImpersonationRules<SocialAction> = {
  'social.read': 'allowed',
  'social.manage': 'forbidden',
  'social.post': 'forbidden',
};

const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);
const MEMBER_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']);

export function can(ctx: Ctx, action: SocialAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, SOCIAL_IMPERSONATION, action)) return false;
  if (resource && resource.agencyId !== ctx.tenant.agencyId) return false;
  const { role } = ctx.actor;
  switch (action) {
    case 'social.read':
    case 'social.post':
      return MEMBER_ROLES.has(role);
    case 'social.manage':
      return ADMIN_ROLES.has(role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
