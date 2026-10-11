import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';

/** Who may do what in agencies (PATTERNS §6). Deny by default; services call `assertCan`. */
export type AgenciesAction = 'agencies.read' | 'agencies.updateDetails';

/** Roles that administer their agency (PLAN §3 #2). */
const ADMIN_ROLES = new Set(['AGENCY_ADMIN', 'DEVELOPER_ADMIN']);

export function can(ctx: Ctx, action: AgenciesAction, resource?: { agencyId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  const sameAgency = !resource || resource.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'agencies.read':
      return sameAgency;
    case 'agencies.updateDetails':
      // Client Mode is read-only (PATTERNS §6).
      return sameAgency && !ctx.clientMode && ADMIN_ROLES.has(ctx.actor.role);
  }
}

export function assertCan(...args: Parameters<typeof can>): void {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}

/**
 * What only a VERIFIED agency may do (PLAN §3 #3): share listings with the network or the public
 * (SHARED / PUBLIC visibility) and create website API keys. Listings (S3-02) and API keys (S1-05)
 * call `assertVerified` before writing.
 */
export type VerifiedAction = 'listing.share' | 'listing.publish' | 'apiKey.create';

export function assertVerified(ctx: Ctx, action: VerifiedAction): void {
  if (!ctx.tenant.verified) throw new AppError('VERIFICATION_REQUIRED', { action });
}
