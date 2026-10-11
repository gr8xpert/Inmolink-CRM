import { withTenant } from '@inmolink/db';
import { DEFAULT_UI_LOCALE } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from './context';
import * as agencies from './modules/agencies';
import * as identity from './modules/identity';

/** What an app knows about a signed-in caller from their access token. */
export interface MemberInit {
  userId: string;
  /** The `agency` claim of the access token. */
  agencyId: string;
  requestId: string;
  /** UI locale of the request; defaults to the agency's first enabled locale. */
  locale?: string;
}

/**
 * Opens `withTenant` for the caller's agency and builds `ctx` from the database, not from the token:
 * role and verification status are read per request (two primary-key lookups), so a role change
 * (S1-02) or a verification decision (S1-03) applies on the next request. A user who is not a
 * member, or whose agency is suspended, gets `FORBIDDEN`.
 */
export function withMemberCtx<T>(init: MemberInit, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return withTenant({ agencyId: init.agencyId, userId: init.userId }, async (tx) => {
    const role = await identity.getMemberRole(tx, init.agencyId, init.userId);
    if (!role) throw new AppError('FORBIDDEN', { reason: 'not_a_member' });
    const tenant = await agencies.loadTenant(tx, init.agencyId);
    if (!tenant) throw new AppError('FORBIDDEN', { reason: 'not_a_member' });
    if (tenant.status === 'SUSPENDED') throw new AppError('FORBIDDEN', { reason: 'agency_suspended' });
    return fn({
      tx,
      tenant: {
        agencyId: init.agencyId,
        verified: tenant.status === 'VERIFIED',
        // Plans arrive with billing (S13); until then every agency is on the same footing.
        plan: 'none',
        locales: tenant.locales,
      },
      actor: { kind: 'user', userId: init.userId, role },
      locale: init.locale ?? tenant.locales[0] ?? DEFAULT_UI_LOCALE,
      requestId: init.requestId,
      clientMode: false,
    });
  });
}
