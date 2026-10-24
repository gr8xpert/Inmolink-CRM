import type { LeadListItemDto } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import dynamic from 'next/dynamic';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { type AssignedFilter, fetchLeadList, fetchPipelineBoard, fetchPipelineStages } from '@/server/crm-api';
import type { BoardColumn, BoardLabels } from './board';
import { contactName, stageLabel, toBoardCards } from './cards';

// Drag-and-drop loads as its own chunk (frontend rules: drag-and-drop via next/dynamic, with a skeleton).
const PipelineBoard = dynamic(() => import('./board'), {
  loading: () => <div className="h-96 animate-pulse rounded-md bg-muted" />,
});

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODES = [
  'generic',
  'VERSION_CONFLICT',
  'FORBIDDEN',
  'PIPELINE_STAGE_NOT_FOUND',
  'VALIDATION_FAILED',
  'LEAD_NOT_FOUND',
] as const;

/**
 * Pipeline (S10-03, PLAN §7 M8): the agency's leads by stage — a board (drag a card to change its stage, or use its
 * keyboard controls) or a list (one stage at a time, newest first). Everyone's leads, mine or the unassigned ones.
 */
export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const view = params.view === 'list' ? 'list' : 'board';
  const assigned: AssignedFilter =
    params.assigned === 'me' || params.assigned === 'unassigned' ? params.assigned : undefined;
  const ref = sessionRef(session.user);
  const t = await getTranslations('leads.pipeline');
  // the board view reads the board (stages, cards, counts); the list view only the stages (its filter and labels)
  const board = view === 'board' ? await fetchPipelineBoard(ref, assigned) : null;
  const stageList = view === 'list' ? await fetchPipelineStages(ref) : null;
  if (board === 'revoked' || stageList === 'revoked') redirect('/session/expired');
  const loaded = board ?? stageList;

  const tabs = (
    <nav aria-label={t('views.label')} className="flex flex-wrap items-center gap-4 text-sm">
      {(['board', 'list'] as const).map((v) => (
        <Link
          key={v}
          href={{ pathname: '/pipeline', query: { view: v, ...(assigned ? { assigned } : {}) } }}
          aria-current={view === v ? 'page' : undefined}
          className={view === v ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
        >
          {t(`views.${v}`)}
        </Link>
      ))}
      <span aria-hidden="true" className="text-muted-foreground">
        |
      </span>
      <span className="text-muted-foreground">{t('filter.label')}:</span>
      {([undefined, 'me', 'unassigned'] as const).map((a) => (
        <Link
          key={a ?? 'all'}
          href={{ pathname: '/pipeline', query: { view, ...(a ? { assigned: a } : {}) } }}
          aria-current={assigned === a ? 'page' : undefined}
          className={
            assigned === a ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'
          }
        >
          {t(`filter.${a ?? 'all'}`)}
        </Link>
      ))}
      <Link href="/pipeline/stages" className="ml-auto underline-offset-4 hover:underline">
        {t('manage')}
      </Link>
    </nav>
  );

  if (!loaded?.ok) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {loaded?.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      </div>
    );
  }
  const stages = board?.ok ? board.data.columns.map((c) => c.stage) : stageList?.ok ? stageList.data.items : [];
  const labelOf = new Map(await Promise.all(stages.map(async (s) => [s.id, await stageLabel(s)] as const)));

  if (view === 'list') {
    const stageId = typeof params.stage === 'string' && UUID.test(params.stage) ? params.stage : undefined;
    const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
    const list = await fetchLeadList(ref, { stageId, cursor, assigned });
    if (list === 'revoked') redirect('/session/expired');
    const format = await getFormatter();
    return (
      <div className="flex flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {tabs}
        <form className="flex items-end gap-2 text-sm" action="" method="get">
          <input type="hidden" name="view" value="list" />
          {assigned ? <input type="hidden" name="assigned" value={assigned} /> : null}
          <label className="flex flex-col gap-1">
            <span>{t('list.stage')}</span>
            <select name="stage" defaultValue={stageId ?? ''} className="h-9 rounded-md border bg-background px-2">
              <option value="">{t('list.allStages')}</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {labelOf.get(s.id)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="h-9 rounded-md border px-3">
            {t('list.filter')}
          </button>
        </form>
        {!list.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : list.data.items.length === 0 ? (
          <EmptyState title={t('list.empty')} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm" data-testid="pipeline-list" aria-label={t('list.label')}>
              <thead className="bg-muted">
                <tr>
                  <th className="p-2">{t('list.contact')}</th>
                  <th className="p-2">{t('list.stage')}</th>
                  <th className="p-2">{t('list.source')}</th>
                  <th className="p-2">{t('list.received')}</th>
                  <th className="p-2">{t('list.assignee')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.items.map((l: LeadListItemDto) => (
                  <tr key={l.id}>
                    <td className="p-2 font-medium">{contactName(l.contact, t('board.noName'))}</td>
                    <td className="p-2">{labelOf.get(l.stageId) ?? t(`stages.${l.status}`)}</td>
                    <td className="p-2">{t(`sources.${l.source}`)}</td>
                    <td className="p-2">{format.dateTime(new Date(l.createdAt), { dateStyle: 'medium' })}</td>
                    <td className="p-2">{l.assignedUserId ? t('board.assigned') : t('board.unassigned')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.ok && list.data.nextCursor ? (
          <Link
            href={{
              pathname: '/pipeline',
              query: {
                view: 'list',
                cursor: list.data.nextCursor,
                ...(stageId ? { stage: stageId } : {}),
                ...(assigned ? { assigned } : {}),
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

  const columns: BoardColumn[] = await Promise.all(
    (board?.ok ? board.data.columns : []).map(async (c) => ({
      stageId: c.stage.id,
      label: labelOf.get(c.stage.id) ?? '',
      kind: c.stage.kind,
      count: c.count,
      countCapped: c.countCapped,
      cards: await toBoardCards(c.items),
      nextCursor: c.nextCursor,
    })),
  );
  const labels: BoardLabels = {
    board: t('board.label'),
    empty: t('board.empty'),
    assigned: t('board.assigned'),
    unassigned: t('board.unassigned'),
    justMoved: t('board.justMoved'),
    more: t('board.more'),
    dragHint: t('board.dragHint'),
    moveTo: t('board.moveTo'),
    move: t('board.move'),
    up: t('board.up'),
    down: t('board.down'),
    moved: t.raw('board.moved') as string,
    saving: t('board.saving'),
    errors: Object.fromEntries(ERROR_CODES.map((c) => [c, t(`errors.${c}`)])),
  };
  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {tabs}
      {columns.length === 0 ? (
        // reads never seed: an agency's stages appear with its first lead (or an admin's first stage change)
        <EmptyState title={t('board.noStages')} />
      ) : (
        // the filter in the key: a new filter remounts the board with its own columns
        <PipelineBoard key={assigned ?? 'all'} columns={columns} assigned={assigned} labels={labels} />
      )}
    </div>
  );
}
