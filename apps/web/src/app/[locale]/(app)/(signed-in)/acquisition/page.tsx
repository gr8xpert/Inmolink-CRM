import { PROSPECT_STAGES, type ProspectDto, ProspectStage } from '@inmolink/contracts';
import { DEFAULT_TIME_ZONE } from '@inmolink/i18n';
import { EmptyState } from '@inmolink/ui';
import dynamic from 'next/dynamic';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchProspectBoard, fetchProspectFollowUps, fetchProspectList } from '@/server/prospects-api';
import { dayBounds } from '../tasks/time';
import type { ProspectBoardLabels, ProspectColumn } from './board';
import { sellerName, toProspectCards } from './cards';
import { groupByDay } from './dates';

// Drag-and-drop loads as its own chunk (frontend rules: drag-and-drop via next/dynamic, with a skeleton).
const ProspectBoard = dynamic(() => import('./board'), {
  loading: () => <div className="h-96 animate-pulse rounded-md bg-muted" />,
});

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const VIEWS = ['board', 'list', 'dates'] as const;
type View = (typeof VIEWS)[number];
/** How far ahead the by-date view looks (the API allows 92 days). */
const DATES_DAYS = 31;
const ERROR_CODES = [
  'generic',
  'VERSION_CONFLICT',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'PROSPECT_NOT_FOUND',
  'PROSPECT_STAGE_INVALID',
] as const;

/**
 * Acquisition (S10-07, PLAN §7 M8): the agency's seller prospects — a board by stage (drag a card, or use its keyboard
 * controls), a list (newest first, one stage or all) and their follow-ups by date (the next month, day by day; overdue
 * ones first).
 */
export default async function AcquisitionPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(params.view ?? '') ? (params.view as View) : 'board';
  const ref = sessionRef(session.user);
  const t = await getTranslations('acquisition');
  const format = await getFormatter();
  const stageLabel = (s: string) => t(`stages.${s}` as `stages.NEW`);

  const header = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link
          href="/acquisition/new"
          className="rounded-md border px-3 py-1.5 text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('new')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {params.done === 'deleted' ? (
        <p role="status" className="text-sm">
          {t('detail.deleted')}
        </p>
      ) : null}
      <nav aria-label={t('views.label')} className="flex flex-wrap items-center gap-4 text-sm">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={{ pathname: '/acquisition', query: { view: v } }}
            aria-current={view === v ? 'page' : undefined}
            className={view === v ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
          >
            {t(`views.${v}`)}
          </Link>
        ))}
      </nav>
    </>
  );
  const failed = (status: number) => (
    <div className="flex flex-col gap-4 p-6">
      {header}
      <p role="alert" className="text-sm text-destructive">
        {status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
      </p>
    </div>
  );
  const table = (items: ProspectDto[], label: string) => (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm" aria-label={label}>
        <thead className="bg-muted">
          <tr>
            <th className="p-2">{t('list.title')}</th>
            <th className="p-2">{t('list.seller')}</th>
            <th className="p-2">{t('list.stage')}</th>
            <th className="p-2">{t('list.price')}</th>
            <th className="p-2">{t('list.followUp')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((p) => (
            <tr key={p.id}>
              <td className="p-2 font-medium">
                <Link href={`/acquisition/${p.id}`} className="underline-offset-4 hover:underline">
                  {p.title}
                </Link>
              </td>
              <td className="p-2">{sellerName(p, t('board.noName'))}</td>
              <td className="p-2">{stageLabel(p.stage)}</td>
              <td className="p-2 tabular-nums">
                {p.estimatedPrice
                  ? format.number(p.estimatedPrice.amountCents / 100, {
                      style: 'currency',
                      currency: p.estimatedPrice.currency,
                      maximumFractionDigits: 0,
                    })
                  : ''}
              </td>
              <td className="p-2">
                {p.nextFollowUpAt
                  ? format.dateTime(new Date(p.nextFollowUpAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: DEFAULT_TIME_ZONE,
                    })
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (view === 'list') {
    const stage = ProspectStage.safeParse(params.stage).data;
    const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
    const mine = params.mine === '1';
    const list = await fetchProspectList(ref, { stage, cursor, assigned: mine ? 'me' : undefined });
    if (list === 'revoked') redirect('/session/expired');
    if (!list.ok) return failed(list.status);
    return (
      <div className="flex flex-col gap-4 p-6">
        {header}
        <form className="flex flex-wrap items-end gap-2 text-sm" action="" method="get">
          <input type="hidden" name="view" value="list" />
          <label className="flex flex-col gap-1">
            <span>{t('list.stage')}</span>
            <select name="stage" defaultValue={stage ?? ''} className="h-9 rounded-md border bg-background px-2">
              <option value="">{t('list.allStages')}</option>
              {PROSPECT_STAGES.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" name="mine" value="1" defaultChecked={mine} />
            <span>{t('list.mine')}</span>
          </label>
          <button type="submit" className="h-9 rounded-md border px-3">
            {t('list.filter')}
          </button>
        </form>
        {list.data.items.length === 0 ? (
          <EmptyState title={t('list.empty')} />
        ) : (
          table(list.data.items, t('list.label'))
        )}
        {list.data.nextCursor ? (
          <Link
            href={{
              pathname: '/acquisition',
              query: {
                view: 'list',
                cursor: list.data.nextCursor,
                ...(stage ? { stage } : {}),
                ...(mine ? { mine: '1' } : {}),
              },
            }}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('list.next')}
          </Link>
        ) : null}
      </div>
    );
  }

  if (view === 'dates') {
    const today = dayBounds(new Date(), DEFAULT_TIME_ZONE).start;
    // overdue follow-ups (up to a month back) first, then the next month day by day
    const from = new Date(today.getTime() - DATES_DAYS * 86_400_000);
    const to = new Date(today.getTime() + DATES_DAYS * 86_400_000);
    const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
    const page = await fetchProspectFollowUps(ref, { from, to, cursor });
    if (page === 'revoked') redirect('/session/expired');
    if (!page.ok) return failed(page.status);
    const groups = groupByDay(page.data.items, (p) => new Date(p.nextFollowUpAt ?? 0), DEFAULT_TIME_ZONE);
    return (
      <div className="flex flex-col gap-4 p-6">
        {header}
        <p className="text-sm text-muted-foreground">{t('dates.range', { days: DATES_DAYS })}</p>
        {groups.length === 0 ? (
          <EmptyState title={t('dates.empty')} />
        ) : (
          <div className="flex flex-col gap-4" data-testid="acquisition-dates">
            {groups.map((g) => {
              const day = new Date(g.items[0]?.nextFollowUpAt ?? 0);
              const overdue = day.getTime() < today.getTime();
              return (
                <section key={g.day} aria-labelledby={`day-${g.day}`} className="flex flex-col gap-2">
                  <h2 id={`day-${g.day}`} className="text-sm font-semibold">
                    {format.dateTime(day, { dateStyle: 'full', timeZone: DEFAULT_TIME_ZONE })}
                    {overdue ? ` · ${t('dates.overdue')}` : ''}
                  </h2>
                  {table(g.items, g.day)}
                </section>
              );
            })}
          </div>
        )}
        {page.data.nextCursor ? (
          <Link
            href={{ pathname: '/acquisition', query: { view: 'dates', cursor: page.data.nextCursor } }}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('list.next')}
          </Link>
        ) : null}
      </div>
    );
  }

  const board = await fetchProspectBoard(ref);
  if (board === 'revoked') redirect('/session/expired');
  if (!board.ok) return failed(board.status);
  const columns: ProspectColumn[] = await Promise.all(
    board.data.columns.map(async (c) => ({
      stage: c.stage,
      label: stageLabel(c.stage),
      count: c.count,
      countCapped: c.countCapped,
      cards: await toProspectCards(c.items),
      nextCursor: c.nextCursor,
    })),
  );
  const labels: ProspectBoardLabels = {
    board: t('board.label'),
    empty: t('board.empty'),
    more: t('board.more'),
    dragHint: t('board.dragHint'),
    moveTo: t('board.moveTo'),
    up: t('board.up'),
    down: t('board.down'),
    open: t('board.open'),
    converted: t('board.converted'),
    moved: t.raw('board.moved') as string,
    saving: t('board.saving'),
    errors: Object.fromEntries(ERROR_CODES.map((c) => [c, t(`errors.${c}`)])),
  };
  return (
    <div className="flex flex-col gap-4 p-6">
      {header}
      <ProspectBoard columns={columns} labels={labels} />
    </div>
  );
}
