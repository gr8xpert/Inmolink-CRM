import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchStaffAccess, sessionRef } from '@/server/api';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Staff access (S1-F9, PLAN §12): the agency's admins see when Inmolink staff acted as one of their
 * members and the reason the staff member gave. Staff identities stay with Inmolink. Other roles get the
 * API's refusal (and no link: the shell offers the page to admins only).
 */
export default async function StaffAccessPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchStaffAccess(sessionRef(session.user), cursor);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff-access');
  const format = await getFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="staff-access">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('when')}</th>
                <th className="p-2">{t('member')}</th>
                <th className="p-2">{t('reason')}</th>
                <th className="p-2">{t('status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="p-2 whitespace-nowrap">{when(a.startedAt)}</td>
                  <td className="p-2">{a.memberName}</td>
                  {/* Free text written by staff: rendered as text, line breaks kept. */}
                  <td className="p-2 whitespace-pre-line">{a.reason}</td>
                  <td className="p-2 whitespace-nowrap">
                    {t(`statuses.${a.status}`, { date: day(a.endedAt ?? a.expiresAt) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/staff-access', query: { cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
    </div>
  );
}
