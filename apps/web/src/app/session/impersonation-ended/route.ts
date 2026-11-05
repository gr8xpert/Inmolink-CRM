import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { routing } from '@/i18n/routing';
import { sessionRef } from '@/server/api';
import { forgetImpersonation, markImpersonationEnded, readImpersonation } from '@/server/impersonation';
import { fetchStaffMe } from '@/server/staff-api';

/**
 * The staff member's impersonation session ended, expired or was revoked (S1-09): pages and actions that could not
 * mint its token land here. S17-F46: every page mints from the impersonation cookie (the dashboard shell does, the
 * console's too), so this is where the browser must stop using it, or the console sends them straight back here.
 *
 * What this GET changes is only what the API has confirmed: `GET /v1/staff/me` (as the staff member themselves, no
 * impersonation) says the session is no longer live. The cookie is then marked ended: nothing mints from it, and the
 * console shows the "session ended, dismiss" banner. So a stray GET never ends a live session (S1-09 review), and the
 * cookies are SameSite=Strict: another site's link arrives without them. Staff access withdrawn: no console and
 * nothing left to dismiss, so the cookie goes. The API unreachable: nothing confirmed, an answer instead of a redirect.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const me = await fetchStaffMe(sessionRef(session.user));
  if (me === 'revoked') redirect('/session/expired');
  const stored = await readImpersonation(session.user.id, { includeEnded: true });
  if (!me.ok && me.status !== 403) return unconfirmed();
  if (!me.ok) {
    if (stored) await forgetImpersonation();
    redirect('/');
  }
  if (stored && me.data.impersonation?.id === stored.id) redirect('/');
  if (stored && !stored.ended) await markImpersonationEnded(stored);
  redirect('/staff/tenants?notice=ended');
}

async function unconfirmed(): Promise<Response> {
  const chosen = (await cookies()).get('NEXT_LOCALE')?.value;
  const locale = hasLocale(routing.locales, chosen) ? chosen : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: 'staff' });
  return new Response(t('impersonation.endedUnconfirmed'), {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' },
  });
}
