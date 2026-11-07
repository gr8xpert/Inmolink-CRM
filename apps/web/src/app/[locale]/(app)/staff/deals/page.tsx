import { DealDisputeStatus } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { fetchStaffDealDisputes } from '@/server/deals-api';
import { requireStaff } from '@/server/staff';

/**
 * Staff deal disputes (R2-04c, PLAN §3 #10 "disputes → staff mediation"): every agency's disputes of a deal by status,
 * oldest first, with the raising agency, its side and the deal's stage; each opens the deal's mediation page. Every
 * staff role reads the queue; data ops and super admins mediate and resolve there. Non-staff get a 404.
 */
export default async function StaffDealsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const status = DealDisputeStatus.catch('OPEN').parse(params.status);
  const cursor =
    typeof params.cursor === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchStaffDealDisputes(session, { status, cursor });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 403) notFound();
  const t = await getTranslations('staff.deals');
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <nav aria-label={t('statusFilter')} className="flex gap-4 text-sm">
        {DealDisputeStatus.options.map((s) => (
          <Link
            key={s}
            href={{ pathname: '/staff/deals', query: { status: s } }}
            aria-current={s === status ? 'page' : undefined}
            className={s === status ? 'font-semibold underline' : 'underline-offset-4 hover:underline'}
          >
            {t(`statuses.${s}`)}
          </Link>
        ))}
      </nav>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="staff-deal-disputes">
          {res.data.items.map((d) => (
            <li key={d.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <Link href={`/staff/deals/${d.dealId}`} className="font-medium underline-offset-4 hover:underline">
                {t('row', { agency: d.agency.name, party: t(`parties.${d.party}`), stage: t(`stages.${d.dealStage}`) })}
              </Link>
              <p className="text-xs text-muted-foreground">
                {t('deal', { id: d.dealId })} · {date(d.createdAt)}
              </p>
              <p>{d.reason}</p>
              {d.resolutionNote ? (
                <p className="text-xs text-muted-foreground">
                  {t('note')}: {d.resolutionNote}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/staff/deals', query: { status, cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
    </div>
  );
}
