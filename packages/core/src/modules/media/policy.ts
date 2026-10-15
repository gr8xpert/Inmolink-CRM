import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import { deniedByImpersonation, type ImpersonationRules } from '../../impersonation';
import * as properties from '../properties';

/**
 * Who may do what in media (PATTERNS §6). Deny by default; services call `assertCan`. Attaching to and
 * detaching from a listing is a listing edit: the service asks `properties.lockListingForMedia`, which applies
 * `listing.update` (owner agency, own listing or admin). Reading a listing's media is `listing.read`.
 */
export const MEDIA_ACTIONS = [
  /** Upload files (check, signed URLs, register) and attach or detach them on listings. */
  'media.manage',
] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

/** Client Mode is read-only (PATTERNS §6): list every read action here, never a write. */
export const CLIENT_MODE_ALLOWED: ReadonlySet<MediaAction> = new Set<MediaAction>([]);

/** Staff impersonating a member may fix a listing's photos, like its other data (S3-02 decision). */
export const MEDIA_IMPERSONATION: ImpersonationRules<MediaAction> = {
  'media.manage': 'allowed',
};

export function can(ctx: Ctx, action: MediaAction): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  if (deniedByImpersonation(ctx, MEDIA_IMPERSONATION, action)) return false;
  switch (action) {
    case 'media.manage':
      // Whoever lists properties uploads their photos (PARTNER members only read).
      return properties.can(ctx, 'listing.create');
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
