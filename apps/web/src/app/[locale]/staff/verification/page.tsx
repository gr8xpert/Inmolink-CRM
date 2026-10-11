import { VerificationRequestStatus } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchVerificationQueue, sessionRef } from '@/server/api';

/**
 * Staff verification queue (S1-03, bare: the staff console shell comes with S1-09). Non-staff get a
 * 404 — the API refuses them with 403, and the page does not reveal that it exists.
 */
export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const status = VerificationRequestStatus.catch('SUBMITTED').parse(params.status);
  const cursor =
    typeof params.cursor === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchVerificationQueue(sessionRef(session.user), { status, cursor });
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
