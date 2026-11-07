import { DEDUPE_REVIEW_STATUSES } from '@inmolink/contracts';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchDuplicateClusters, fetchDuplicateReviews } from '@/server/dedupe-api';
import { inClientMode } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { decideDuplicateAction, disputeDuplicateAction } from './actions';
import { ClusterList, ReviewList } from './duplicate-lists';
import { doneOf, parseDuplicatesState, viewQuery } from './query';

/**
 * Duplicate listings (R2-03b, PLAN §10): the review queue of likely duplicates of the agency's listings (pending,
 * confirmed, not duplicates), and its grouped listings with a dispute form. Newest first, "load more" by cursor.
 * Server-rendered, no client JS of its own; every rule (who may decide, which listings may be seen) is the API's.
 */
export default async function DuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const q = await searchParams;
  const state = parseDuplicatesState(q);
  const ref = sessionRef(session.user);
  const res =
    state.view === 'clusters'
      ? { view: 'clusters' as const, r: await fetchDuplicateClusters(ref, state.cursor) }
      : {
          view: 'reviews' as const,
          r: await fetchDuplicateReviews(ref, { status: state.status, cursor: state.cursor }),
        };
  if (res.r === 'revoked') redirect('/session/expired');
  const result = res.r;
  const t = await getTranslations('listings.duplicates');
  const format = await getFormatter();
  const view = viewQuery(state);
  const done = doneOf(q.done);
  const errorCode = typeof q.error === 'string' ? q.error : null;
  const tr = (key: string, values?: Record<string, string | number>) => t(key as never, values as never);
  const money = (amountCents: number, currency: string) =>
    format.number(amountCents / 100, { style: 'currency', currency, maximumFractionDigits: 0 });
  const percent = (f: number) => format.number(f, { style: 'percent', maximumFractionDigits: 0 });
  const pill = (active: boolean) =>
    active
      ? 'rounded-md border bg-muted px-3 py-1 font-medium'
      : 'rounded-md border px-3 py-1 underline-offset-4 hover:underline';

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>

      <nav aria-label={t('viewsLabel')} className="flex flex-wrap items-center gap-2 text-sm">
        {(['reviews', 'clusters'] as const).map((v) => (
          <Link
            key={v}
            href={{ pathname: '/duplicates', query: viewQuery({ ...state, view: v, status: 'PENDING' }) }}
            aria-current={state.view === v ? 'true' : undefined}
            className={pill(state.view === v)}
          >
            {t(`views.${v}`)}
          </Link>
        ))}
      </nav>
      {state.view === 'reviews' ? (
        <nav aria-label={t('statusFilter')} className="flex flex-wrap items-center gap-2 text-sm">
          <span aria-hidden="true">{t('statusFilter')}:</span>
          {DEDUPE_REVIEW_STATUSES.map((s) => (
            <Link
              key={s}
              href={{ pathname: '/duplicates', query: viewQuery({ ...state, status: s }) }}
              aria-current={state.status === s ? 'true' : undefined}
              className={pill(state.status === s)}
            >
              {t(`statuses.${s}`)}
            </Link>
          ))}
        </nav>
      ) : null}

      {done ? (
        <p role="status" className="text-sm">
          {t(`done.${done}`)}
        </p>
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t.has(`errors.${errorCode}` as never) ? t(`errors.${errorCode}` as never) : t('errors.generic')}
        </p>
      ) : null}

      {!result.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {result.error?.code && t.has(`errors.${result.error.code}` as never)
            ? t(`errors.${result.error.code}` as never)
            : t('errors.load')}
        </p>
      ) : (
        <>
          {res.view === 'clusters' && res.r.ok ? (
            <ClusterList
              items={res.r.data.items}
              t={tr}
              money={money}
              back={view}
              dispute={disputeDuplicateAction}
              more={result.data.nextCursor !== null}
            />
          ) : res.view === 'reviews' && res.r.ok ? (
            <ReviewList
              items={res.r.data.items}
              status={state.status}
              t={tr}
              money={money}
              percent={percent}
              back={view}
              decide={decideDuplicateAction}
              more={result.data.nextCursor !== null}
            />
          ) : null}
          {result.data.nextCursor ? (
            <Link
              href={{ pathname: '/duplicates', query: { ...view, cursor: result.data.nextCursor } }}
              className="self-start text-sm font-medium underline-offset-4 hover:underline"
            >
              {t('loadMore')}
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
