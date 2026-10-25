import { SupportTicketStatus } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchStaffSupportQueue } from '@/server/support-api';

/**
 * Staff support queue (S13-05, PLAN §7 M21), inside the staff console shell: every agency's tickets by status, oldest
 * first. Non-staff get a 404 (the API refuses them with 403).
 */
export default async function StaffSupportQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const status = SupportTicketStatus.catch('OPEN').parse(params.status);
  const cursor =
    typeof params.cursor === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchStaffSupportQueue(session, { status, cursor });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 403) notFound();
  const t = await getTranslations('support');
  const format = await getFormatter();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('staff.title')}</h1>
      <nav className="flex gap-4 text-sm">
        {SupportTicketStatus.options.map((s) => (
          <Link
            key={s}
            href={{ pathname: '/staff/support', query: { status: s } }}
            aria-current={s === status ? 'page' : undefined}
            className={s === status ? 'font-semibold underline' : 'underline-offset-4 hover:underline'}
          >
            {t(`status.${s}`)}
          </Link>
        ))}
      </nav>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('staff.empty')} />
      ) : (
        <ul className="divide-y rounded-md border" data-testid="staff-support-queue">
          {res.data.items.map((ticket) => (
            <li key={ticket.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{ticket.subject}</p>
                <p className="text-xs text-muted-foreground">
                  {ticket.agency.name} · {t(`categories.${ticket.category}`)} · {t(`priorities.${ticket.priority}`)} ·{' '}
                  {t('staff.opened', {
                    date: format.dateTime(new Date(ticket.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
                  })}{' '}
                  · {ticket.assigneeUserId ? t('staff.assigned') : t('staff.unassigned')}
                </p>
              </div>
              <Link href={`/staff/support/${ticket.id}`} className="font-medium underline-offset-4 hover:underline">
                {t('staff.open')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/staff/support', query: { status, cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('staff.next')}
        </Link>
      ) : null}
    </div>
  );
}
