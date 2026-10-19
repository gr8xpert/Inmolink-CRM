import type { FeedConnectionDto } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { fetchFeedConnections, sessionRef } from '@/server/api';
import { runNowAction } from './actions';
import { ImportNotice, StateBadge, scheduleLabel } from './shared';

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Feed imports (S6-01): the agency's feed connections with their schedule and last run, a "run now" per feed, and
 * a link to each feed's run history. Connecting a feed arrives with the connectors (S6-03+). Admins and agents;
 * the API refuses everyone else.
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchFeedConnections(sessionRef(session.user), cursor);
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('imports');
  const format = await getFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <ImportNotice done={params.done} error={params.error} />
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.generic')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" data-testid="feed-connections">
            <thead className="bg-muted">
              <tr>
                <th className="p-2">{t('connection')}</th>
                <th className="p-2">{t('connector')}</th>
                <th className="p-2">{t('schedule')}</th>
                <th className="p-2">{t('lastRun')}</th>
                <th className="p-2">
                  <span className="sr-only">{t('runNow')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {res.data.items.map((c: FeedConnectionDto) => (
                <tr key={c.id}>
                  <td className="p-2">
                    <Link href={`/imports/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                      {c.name}
                    </Link>
                    {c.enabled ? null : <span className="ml-2 text-xs text-muted-foreground">({t('disabled')})</span>}
                  </td>
                  <td className="p-2 font-mono text-xs">{c.connector}</td>
                  <td className="p-2 whitespace-nowrap">{scheduleLabel(t, c.scheduleMinutes)}</td>
                  <td className="p-2 whitespace-nowrap">
                    {c.lastRunAt && c.lastRunState ? (
                      <span className="flex items-center gap-2">
                        <StateBadge state={c.lastRunState} label={t(`states.${c.lastRunState}`)} />
                        {when(c.lastRunAt)}
                      </span>
                    ) : (
                      t('never')
                    )}
                  </td>
                  <td className="p-2 text-right">
                    {c.enabled ? (
                      <form action={runNowAction}>
                        <input type="hidden" name="connectionId" value={c.id} />
                        <Button type="submit" size="sm" variant="outline">
                          {t('runNow')}
                        </Button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/imports', query: { cursor: res.data.nextCursor } }}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('next')}
        </Link>
      ) : null}
    </div>
  );
}
