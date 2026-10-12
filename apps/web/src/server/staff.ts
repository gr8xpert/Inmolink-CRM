import type { StaffMeDto } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/auth';
import { type SessionRef, sessionRef } from './api';
import { fetchStaffMe } from './staff-api';

/**
 * Every staff page and the staff layout start here (S1-09): anyone who is not active staff — signed
 * out, a tenant, a user whose staff role was withdrawn — gets the same 404 as an unknown page, so the
 * console does not reveal that it exists. One `GET /v1/staff/me` per request (`cache`), shared by the
 * layout and the page.
 */
export const requireStaff = cache(async (): Promise<{ session: SessionRef; me: StaffMeDto }> => {
  const s = await auth();
  if (!s?.user?.id) notFound();
  const session = sessionRef(s.user);
  const me = await fetchStaffMe(session);
  if (me === 'revoked') redirect('/session/expired');
  if (!me.ok) notFound();
  return { session, me: me.data };
});
