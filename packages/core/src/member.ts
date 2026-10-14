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
  /**
   * Staff acting as `userId` (S1-09): the token's `imp` (session) and `act` (staff member) claims. The
   * session is checked in this request's transaction; every write then names the staff member too.
   */
  impersonation?: { id: string; staffUserId: string; sessionVersion: number };
}

/**
 * Opens `withTenant` for the caller's agency and builds `ctx` from the database, not from the token:
 * role and verification status are read per request (two primary-key reads), so a role change
 * (S1-02) or a verification decision (S1-03) applies on the next request. A user who is not a
 * member, or whose agency is suspended, gets `FORBIDDEN`. An impersonated call (S1-09) also needs its
 * session to be live (checked in the same statement as the role) and its staff member to still be
 * impersonating staff with a current login (one `app_auth` read first): ended, expired, revoked,
 * downgraded or signed out → `IMPERSONATION_ENDED`. Three statements before the handler (S2-F1).
 */
export async function withMemberCtx<T>(init: MemberInit, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const imp = init.impersonation;
  if (imp && !(await identity.isImpersonatorCurrent(imp.staffUserId, imp.sessionVersion))) {
    throw new AppError('IMPERSONATION_ENDED', { reason: 'staff_access' });
  }
  return withTenant(
    { agencyId: init.agencyId, userId: init.userId, ...(imp ? { impersonatedBy: imp.staffUserId } : {}) },
    async (tx) => {
      const { role, live } = await identity.getMemberAccess(tx, {
        agencyId: init.agencyId,
        userId: init.userId,
        ...(imp ? { impersonationId: imp.id } : {}),
      });
      if (!live) throw new AppError('IMPERSONATION_ENDED');
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
        actor: { kind: 'user', userId: init.userId, role, ...(imp ? { impersonatedBy: imp.staffUserId } : {}) },
        locale: init.locale ?? tenant.locales[0] ?? DEFAULT_UI_LOCALE,
        requestId: init.requestId,
        clientMode: false,
      });
    },
  );
}
