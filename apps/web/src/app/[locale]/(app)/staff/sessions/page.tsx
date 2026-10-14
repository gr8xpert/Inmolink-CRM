import { Button, EmptyState } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchLiveImpersonations } from '@/server/staff-api';
import { endSessionAsSuperAdminAction } from '../actions';

/**
 * Live impersonation sessions of all staff (S1-F9): super admins see who is acting as whom and can end
 * any session; it stops on that staff member's next request. 404 for every other role.
 */
export default async function StaffSessionsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, me } = await requireStaff();
  if (me.role !== 'SUPER_ADMIN') notFound();
  const res = await fetchLiveImpersonations(session);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const params = await searchParams;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('live.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('live.intro')}</p>
      {params.notice === 'ended' ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t('live.ended')}
        </p>
      ) : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('live.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="staff-live-sessions">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('live.staff')}</th>
                <th className="p-2">{t('live.actingAs')}</th>
                <th className="p-2">{t('live.until')}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((s) => (
                <tr key={s.id}>
                  <td className="p-2">{s.staffName}</td>
                  <td className="p-2">
                    {s.userName} ·{' '}
                    <Link href={`/staff/tenants/${s.agencyId}`} className="underline-offset-4 hover:underline">
                      {s.agencyName}
                    </Link>
                  </td>
                  <td className="p-2 whitespace-nowrap">
                    {format.dateTime(new Date(s.expiresAt), { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="p-2 text-right">
                    <form action={endSessionAsSuperAdminAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <Button type="submit" size="sm" variant="outline">
                        {t('live.end')}
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
