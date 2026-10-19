import { FEED_RUN_ERROR_CODES, type FeedRunDto } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchFeedConnectionPage, sessionRef } from '@/server/api';
import { runNowAction } from '../actions';
import { ImportNotice, StateBadge, scheduleLabel } from '../shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const COUNT_KEYS = ['total', 'valid', 'failed', 'created', 'updated', 'unchanged'] as const;

/**
 * One feed's run history (S6-01): every run with its trigger, status, timings and counts, newest first; a failed
 * run says why. `?run=<id>` lists that run's refused items (position, reference, problem, field) below.
 */
export default async function FeedConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const q = await searchParams;
  const cursor = q.cursor && CURSOR.test(q.cursor) ? q.cursor : undefined;
  const runId = q.run && UUID.test(q.run) ? q.run : undefined;
  const errorsCursor = q.errors && CURSOR.test(q.errors) ? q.errors : undefined;
  const res = await fetchFeedConnectionPage(sessionRef(session.user), id, { cursor, runId, errorsCursor });
  if (res === 'revoked') redirect('/session/expired');
  if (!res.connection.ok && res.connection.status === 404) notFound();
  const t = await getTranslations('imports');
  const format = await getFormatter();
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const runError = (code: string | null) =>
    code ? t(`runErrors.${FEED_RUN_ERROR_CODES.find((c) => c === code) ?? 'INTERNAL'}`) : null;

  if (!res.connection.ok) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      </div>
    );
  }
  const connection = res.connection.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{connection.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{connection.connector}</span> · {scheduleLabel(t, connection.scheduleMinutes)}
            {connection.enabled ? null : ` · ${t('disabled')}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {connection.enabled ? (
            <form action={runNowAction}>
              <input type="hidden" name="connectionId" value={connection.id} />
              <input type="hidden" name="from" value="detail" />
              <Button type="submit" size="sm">
                {t('runNow')}
              </Button>
            </form>
          ) : null}
          <Link href="/imports" className="text-sm underline-offset-4 hover:underline">
            {t('back')}
          </Link>
        </div>
      </div>
      <ImportNotice done={q.done} error={q.error} />

      <h2 className="text-lg font-semibold">{t('history')}</h2>
      {!res.runs.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.runs.data.items.length === 0 ? (
        <EmptyState title={t('noRuns')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="feed-runs">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('started')}</th>
                <th className="p-2">{t('finished')}</th>
                <th className="p-2">{t('trigger')}</th>
                <th className="p-2">{t('state')}</th>
                {COUNT_KEYS.map((k) => (
                  <th key={k} className="p-2 text-right">
                    {t(`counts.${k}`)}
                  </th>
                ))}
                <th className="p-2">
                  <span className="sr-only">{t('showErrors')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.runs.data.items.map((r: FeedRunDto) => (
                <tr key={r.id} className={r.id === runId ? 'bg-accent/40' : undefined}>
                  <td className="p-2 whitespace-nowrap">{when(r.startedAt ?? r.createdAt)}</td>
                  <td className="p-2 whitespace-nowrap">{when(r.finishedAt)}</td>
                  <td className="p-2">{t(`triggers.${r.trigger}`)}</td>
                  <td className="p-2">
                    <StateBadge state={r.state} label={t(`states.${r.state}`)} />
                    {r.errorCode ? <p className="mt-1 text-xs text-destructive">{runError(r.errorCode)}</p> : null}
                  </td>
                  {COUNT_KEYS.map((k) => (
                    <td key={k} className="p-2 text-right tabular-nums">
                      {format.number(r.counts[k])}
                    </td>
                  ))}
                  <td className="p-2 whitespace-nowrap">
                    {r.counts.failed > 0 ? (
                      <Link
                        href={{
                          pathname: `/imports/${connection.id}`,
                          query: { ...(cursor ? { cursor } : {}), run: r.id },
                        }}
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {t('showErrors')}
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.runs.ok && res.runs.data.nextCursor ? (
        <Link
          href={{ pathname: `/imports/${connection.id}`, query: { cursor: res.runs.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}

      {res.run && res.errors ? (
        <section className="flex flex-col gap-3" aria-labelledby="item-errors">
          <h2 id="item-errors" className="text-lg font-semibold">
            {t('itemErrors', { date: when(res.run.startedAt ?? res.run.createdAt) })}
          </h2>
          {res.run.counts.failed > res.run.errorsLogged ? (
            <p className="text-sm text-muted-foreground">
              {t('itemErrorsCapped', { kept: res.run.errorsLogged, failed: res.run.counts.failed })}
            </p>
          ) : null}
          {res.errors.items.length === 0 ? (
            <EmptyState title={t('noItemErrors')} />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm" data-testid="feed-item-errors">
                <thead className="bg-muted">
                  <tr>
                    <th className="p-2 text-right">{t('position')}</th>
                    <th className="p-2">{t('itemRef')}</th>
                    <th className="p-2">{t('code')}</th>
                    <th className="p-2">{t('field')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {res.errors.items.map((e) => (
                    <tr key={e.id}>
                      <td className="p-2 text-right tabular-nums">{format.number(e.position + 1)}</td>
                      {/* Feed content: rendered as text. */}
                      <td className="p-2 font-mono text-xs">{e.itemRef ?? '—'}</td>
                      <td className="p-2 font-mono text-xs" title={e.message ?? undefined}>
                        {e.code}
                      </td>
                      <td className="p-2 font-mono text-xs">{e.field ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.errors.nextCursor ? (
            <Link
              href={{
                pathname: `/imports/${connection.id}`,
                query: { ...(cursor ? { cursor } : {}), run: res.run.id, errors: res.errors.nextCursor },
              }}
              className="text-sm font-medium underline-offset-4 hover:underline"
            >
              {t('moreErrors')}
            </Link>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
