import { withStaff, withTenant } from '@inmolink/db';
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
 * role and verification status are read per request (two primary-key lookups), so a role change
 * (S1-02) or a verification decision (S1-03) applies on the next request. A user who is not a
 * member, or whose agency is suspended, gets `FORBIDDEN`. An impersonated call (S1-09) also needs its
 * session to be live (one more primary-key lookup) and its staff member to still be impersonating staff
 * (one `app_staff` read): ended, expired, revoked or downgraded → `IMPERSONATION_ENDED`.
 */
export async function withMemberCtx<T>(init: MemberInit, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const imp = init.impersonation;
  if (imp) {
    // The staff member must still be active staff with a role that may impersonate (S1-09 review), and
    // their login must be ACTIVE with the session version the token was minted for (S1-F9): two short
    // reads before the request's own transaction (impersonated calls only; `app_staff` cannot read
    // `users`, so the login is checked as `app_auth`).
    const [active, current] = await Promise.all([
      withStaff({ userId: imp.staffUserId, reason: 'identity.checkImpersonator' }, (tx) =>
        identity.isImpersonatorActive(tx, imp.staffUserId),
      ),
      identity.isStaffLoginCurrent(imp.staffUserId, imp.sessionVersion),
    ]);
    if (!active || !current) throw new AppError('IMPERSONATION_ENDED', { reason: 'staff_access' });
  }
  return withTenant(
    { agencyId: init.agencyId, userId: init.userId, ...(imp ? { impersonatedBy: imp.staffUserId } : {}) },
    async (tx) => {
      if (
        imp &&
        !(await identity.isImpersonationLive(tx, {
          id: imp.id,
          agencyId: init.agencyId,
          staffUserId: imp.staffUserId,
          targetUserId: init.userId,
        }))
      ) {
        throw new AppError('IMPERSONATION_ENDED');
      }
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
        actor: { kind: 'user', userId: init.userId, role, ...(imp ? { impersonatedBy: imp.staffUserId } : {}) },
        locale: init.locale ?? tenant.locales[0] ?? DEFAULT_UI_LOCALE,
        requestId: init.requestId,
        clientMode: false,
      });
    },
  );
}
