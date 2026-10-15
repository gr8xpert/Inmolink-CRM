import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/** Who may do what in quality (PATTERNS §6). Deny by default; services call `assertCan`. */
export type QualityAction = 'quality.read';

/**
 * Client Mode is read-only (PATTERNS §6); the quality score and its hints are internal (a client never sees them,
 * like the score on the listing), so not even the read is allowed.
 */
export const CLIENT_MODE_ALLOWED: ReadonlySet<QualityAction> = new Set<QualityAction>();

/** Any member reads the score of their agency's listings (agents fix their own; the hints are no secret). */
export function can(ctx: Ctx, action: QualityAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && !CLIENT_MODE_ALLOWED.has(action)) return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'quality.read':
      return sameAgency;
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
