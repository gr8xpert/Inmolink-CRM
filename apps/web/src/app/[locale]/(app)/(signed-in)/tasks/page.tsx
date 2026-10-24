import { randomUUID } from 'node:crypto';
import type { TaskDto } from '@inmolink/contracts';
import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { agencyTimeZone } from '@/server/agency-time-zone';
import { sessionRef } from '@/server/api';
import { fetchTasks, type TaskListOptions } from '@/server/crm-api';
import { addTaskAction, taskIntentAction } from './actions';
import { dayBounds } from './time';

const TABS = ['overdue', 'today', 'upcoming', 'noDate', 'done'] as const;
type Tab = (typeof TABS)[number];
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const ERROR_CODES = ['generic', 'VERSION_CONFLICT', 'TASK_NOT_FOUND', 'VALIDATION_FAILED', 'FORBIDDEN'] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

/** What each tab asks the API for (days are the agency's calendar days). */
function queryFor(tab: Tab, now: Date, timeZone: string): Omit<TaskListOptions, 'assignee' | 'cursor'> {
  const { end } = dayBounds(now, timeZone);
  switch (tab) {
    case 'overdue':
      return { status: 'OPEN', dueTo: now };
    case 'today':
      return { status: 'OPEN', dueFrom: now, dueTo: end };
    case 'upcoming':
      return { status: 'OPEN', dueFrom: end };
    case 'noDate':
      return { status: 'OPEN', noDue: true };
    case 'done':
      return { status: 'DONE' };
  }
}

/**
 * My tasks (S10-05, PLAN §7 M8): the member's to-dos by when they are due — overdue, today, upcoming, undated, done —
 * or everyone's in the agency. Add a task, mark it done, reopen or delete it. Reminders go out by e-mail at the due time.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(params.tab ?? '') ? (params.tab as Tab) : 'today';
  const scope = params.scope === 'all' ? 'all' : 'mine';
  const cursor = typeof params.cursor === 'string' && CURSOR.test(params.cursor) ? params.cursor : undefined;
  const t = await getTranslations('tasks');
  const format = await getFormatter();
  const ref = sessionRef(session.user);
  const timeZone = await agencyTimeZone(ref);
  const res = await fetchTasks(ref, {
    ...queryFor(tab, new Date(), timeZone),
    assignee: scope === 'all' ? 'any' : 'me',
    cursor,
  });
  if (res === 'revoked') redirect('/session/expired');

  const keep = (extra: Record<string, string>) => ({
    pathname: '/tasks' as const,
    query: { tab, ...(scope === 'all' ? { scope } : {}), ...extra },
  });
  const error: ErrorCode | null = params.error
    ? (ERROR_CODES as readonly string[]).includes(params.error)
      ? (params.error as ErrorCode)
      : 'generic'
    : null;
  const hidden = (
    <>
      <input type="hidden" name="tab" value={tab} />
      <input type="hidden" name="scope" value={scope} />
    </>
  );

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <form action={addTaskAction} className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
        {hidden}
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <label className="flex min-w-60 flex-1 flex-col gap-1">
          <span>{t('form.title')}</span>
          <input name="title" required maxLength={200} className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('form.dueAt')}</span>
          <input name="dueAt" type="datetime-local" className="h-9 rounded-md border bg-background px-2" />
        </label>
        <label className="flex items-center gap-2">
          <input name="remind" type="checkbox" defaultChecked />
          <span>{t('form.remind')}</span>
        </label>
        <button type="submit" className="h-9 rounded-md border px-3 font-medium">
          {t('form.create')}
        </button>
      </form>

      <nav aria-label={t('title')} className="flex flex-wrap items-center gap-4 text-sm">
        {TABS.map((id) => (
          <Link
            key={id}
            href={{ pathname: '/tasks', query: { tab: id, ...(scope === 'all' ? { scope } : {}) } }}
            aria-current={tab === id ? 'page' : undefined}
            className={tab === id ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'}
          >
            {t(`tabs.${id}`)}
          </Link>
        ))}
        <span aria-hidden="true" className="text-muted-foreground">
          |
        </span>
        <span className="text-muted-foreground">{t('scope.label')}:</span>
        {(['mine', 'all'] as const).map((s) => (
          <Link
            key={s}
            href={{ pathname: '/tasks', query: { tab, ...(s === 'all' ? { scope: s } : {}) } }}
            aria-current={scope === s ? 'page' : undefined}
            className={
              scope === s ? 'font-semibold underline underline-offset-4' : 'underline-offset-4 hover:underline'
            }
          >
            {t(`scope.${s}`)}
          </Link>
        ))}
      </nav>

      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t(`empty.${tab}`)} />
      ) : (
        <ul className="divide-y rounded-md border" data-testid="task-list">
          {res.data.items.map((task: TaskDto) => (
            <li key={task.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <div className="flex min-w-60 flex-1 flex-col">
                <span className={task.status === 'DONE' ? 'font-medium line-through' : 'font-medium'}>
                  {task.title}
                </span>
                {task.description ? <span className="text-muted-foreground">{task.description}</span> : null}
                <span className="text-muted-foreground">
                  {task.dueAt
                    ? t('meta.due', {
                        when: format.dateTime(new Date(task.dueAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone,
                        }),
                      })
                    : t('meta.noDue')}
                  {task.reminderSent ? ` · ${t('meta.reminded')}` : ''}
                </span>
              </div>
              <form action={taskIntentAction} className="flex gap-2">
                {hidden}
                <input type="hidden" name="id" value={task.id} />
                <input type="hidden" name="version" value={task.version} />
                <button
                  type="submit"
                  name="intent"
                  value={task.status === 'DONE' ? 'reopen' : 'complete'}
                  className="h-8 rounded-md border px-3"
                >
                  {task.status === 'DONE' ? t('actions.reopen') : t('actions.complete')}
                </button>
                <button type="submit" name="intent" value="delete" className="h-8 rounded-md border px-3">
                  {t('actions.delete')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={keep({ cursor: res.data.nextCursor })}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('loadMore')}
        </Link>
      ) : null}
    </div>
  );
}
