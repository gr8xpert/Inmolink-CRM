import { DedupeDisputeStatus } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { fetchStaffDuplicateDisputes } from '@/server/dedupe-api';
import { requireStaff } from '@/server/staff';
import { resolveDisputeAction } from './actions';

/**
 * Staff duplicate disputes (R2-03b, PLAN §10): every agency's disputes of how its listings were grouped, by status,
 * oldest first, each with the group as it is now; data ops and super admins uphold or reject an open one with a note
 * (audited; an upheld one is applied by the worker). Non-staff get a 404 (the API refuses them with 403).
 */
export default async function StaffDuplicatesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session } = await requireStaff();
  const params = await searchParams;
  const status = DedupeDisputeStatus.catch('OPEN').parse(params.status);
  const cursor =
    typeof params.cursor === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchStaffDuplicateDisputes(session, { status, cursor });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 403) notFound();
  const t = await getTranslations('staff.duplicates');
  const format = await getFormatter();
  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <nav className="flex gap-4 text-sm">
        {DedupeDisputeStatus.options.map((s) => (
          <Link
            key={s}
            href={{ pathname: '/staff/duplicates', query: { status: s } }}
            aria-current={s === status ? 'page' : undefined}
            className={s === status ? 'font-semibold underline' : 'underline-offset-4 hover:underline'}
          >
            {t(`statuses.${s}`)}
          </Link>
        ))}
      </nav>
      {params.notice === 'resolved' ? (
        <p role="status" className="text-sm">
          {t('notice')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t.has(`errors.${error}` as never) ? t(`errors.${error}` as never) : t('errors.generic')}
        </p>
      ) : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="staff-duplicate-disputes">
          {res.data.items.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
              <p className="font-medium">
                {d.agency.name} · {t(`kinds.${d.kind}`)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('listing', { id: d.listingId })} ·{' '}
                {format.dateTime(new Date(d.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
              <p>
                <span className="text-xs text-muted-foreground">{t('reason')}: </span>
                {d.reason}
              </p>
              <div>
                <p className="text-xs text-muted-foreground">{t('members')}</p>
                {d.members.length === 0 ? (
                  <p className="text-xs">{t('noMembers')}</p>
                ) : (
                  <ol className="text-xs">
                    {d.members.map((m) => (
                      <li key={m.listingId} className={m.listingId === d.listingId ? 'font-semibold' : undefined}>
                        {t('member', { rank: m.rank + 1, listing: m.listingId, agency: m.agencyId, via: m.via })}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {d.status === 'OPEN' ? (
                <form action={resolveDisputeAction} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={d.id} />
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{t('note')}</span>
                    <textarea name="note" required maxLength={1000} rows={2} className="rounded-md border p-2" />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      name="outcome"
                      value="UPHELD"
                      className="h-8 rounded-md border bg-primary px-3 text-primary-foreground"
                    >
                      {t('uphold')}
                    </button>
                    <button type="submit" name="outcome" value="REJECTED" className="h-8 rounded-md border px-3">
                      {t('reject')}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="text-xs">
                  {t('resolved', { status: t(`statuses.${d.status}`) })}
                  {d.resolutionNote ? ` · ${d.resolutionNote}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/staff/duplicates', query: { status, cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
    </div>
  );
}
