import { VerificationRequestStatus } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { fetchVerificationQueue } from '@/server/api';
import { requireStaff } from '@/server/staff';

/**
 * Staff verification queue (S1-03), inside the staff console shell (S1-09). Non-staff — signed out too — get a
 * 404 — the API refuses them with 403, and the page does not reveal that it exists.
 */
export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const status = VerificationRequestStatus.catch('SUBMITTED').parse(params.status);
  const cursor =
    typeof params.cursor === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchVerificationQueue(session, { status, cursor });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 403) notFound();
  const t = await getTranslations('staff');
  const format = await getFormatter();

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('queue.title')}</h1>
      <nav className="flex gap-4 text-sm">
        {VerificationRequestStatus.options.map((s) => (
          <Link
            key={s}
            href={{ pathname: '/staff/verification', query: { status: s } }}
            aria-current={s === status ? 'page' : undefined}
            className={s === status ? 'font-semibold underline' : 'underline-offset-4 hover:underline'}
          >
            {t(`queue.tabs.${s}`)}
          </Link>
        ))}
      </nav>
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('queue.empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="verification-queue">
          {res.data.items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{r.agency.name}</p>
                <p className="text-xs text-muted-foreground">
                  {r.agency.taxId ?? '—'} ·{' '}
                  {t('queue.submitted', { date: format.dateTime(new Date(r.submittedAt), { dateStyle: 'medium' }) })}
                </p>
              </div>
              <Link href={`/staff/verification/${r.id}`} className="font-medium underline-offset-4 hover:underline">
                {t('queue.open')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/staff/verification', query: { status, cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('queue.next')}
        </Link>
      ) : null}
    </main>
  );
}
