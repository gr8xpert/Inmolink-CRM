import { withStaff } from '@inmolink/db';
import { DEFAULT_UI_LOCALE } from '@inmolink/i18n';
import { AppError } from '@inmolink/platform/errors';
import type { StaffCtx } from './context';
import * as identity from './modules/identity';

/** What an app knows about a signed-in staff caller from their access token. */
export interface StaffInit {
  userId: string;
  requestId: string;
  /** Names the use case for the transaction's `app.staff_reason` (audit), e.g. `agencies.decideVerification`. */
  reason: string;
  locale?: string;
}

/**
 * Opens `withStaff` and builds a staff `ctx` from the database: the staff role is read per request,
 * so withdrawing it applies on the next call. A non-staff user gets `FORBIDDEN` (staff APIs answer
 * 403, S1-09). Inside, RLS lets `app_staff` reach only the registry's `staff` predicates.
 */
export function withStaffCtx<T>(init: StaffInit, fn: (ctx: StaffCtx) => Promise<T>): Promise<T> {
  return withStaff({ userId: init.userId, reason: init.reason }, async (tx) => {
    const role = await identity.getStaffRole(tx, init.userId);
    if (!role) throw new AppError('FORBIDDEN', { reason: 'not_staff' });
    return fn({
      tx,
      actor: { kind: 'staff', userId: init.userId, role },
      locale: init.locale ?? DEFAULT_UI_LOCALE,
      requestId: init.requestId,
    });
  });
}
