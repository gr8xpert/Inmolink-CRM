import {
  STAFF_OPERATION_ROLES,
  type StaffOperationDto,
  StaffOperationKind,
  StaffOperationState,
} from '@inmolink/contracts';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchStaffOperations } from '@/server/staff-ops-api';
import { cancelOperationAction, startOperationAction } from './actions';

const ERRORS = [
  'FORBIDDEN',
  'STAFF_OPERATION_ACTIVE',
  'STAFF_OPERATION_NOT_FOUND',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'OUTBOX_REPLAY_TYPE_REFUSED',
] as const;
const OPERATORS: ReadonlySet<string> = new Set(STAFF_OPERATION_ROLES);

/**
 * Staff bulk operations (S13-03, PLAN §7 M20): reindex, rebuild read models, re-import, replay an outbox window — for
 * one agency or all — as audited background jobs with progress; data ops and super admins start and cancel them.
 * Every staff role may look. Progress is read on each load (Refresh).
 */
export default async function StaffOperationsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, me } = await requireStaff();
  const params = await searchParams;
  const state = StaffOperationState.safeParse(params.state);
  const res = await fetchStaffOperations(session, {
    state: state.success ? state.data : undefined,
    cursor: params.cursor,
  });
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('staff');
  const format = await getFormatter();
  const canRun = OPERATORS.has(me.role);
  const error = params.error ? (ERRORS.find((c) => c === params.error) ?? 'generic') : null;
  const notice = params.notice === 'started' || params.notice === 'cancelled' ? params.notice : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('ops.operations.title')}</h1>
        <Link href="/staff/operations" className="text-sm underline-offset-4 hover:underline">
          {t('ops.operations.refresh')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('ops.operations.intro')}</p>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`ops.operations.notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error === 'generic' ? t('errors.generic') : t(`ops.operations.errors.${error}`)}
        </p>
      ) : null}

      {canRun ? (
        <section aria-labelledby="start-op" className="flex flex-col gap-3 rounded-md border p-4">
          <h2 id="start-op" className="font-medium">
            {t('ops.operations.startTitle')}
          </h2>
          <form action={startOperationAction} className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="op-kind">{t('ops.operations.kind')}</Label>
              <select id="op-kind" name="kind" className="h-9 rounded-md border bg-background px-2 text-sm">
                {StaffOperationKind.options.map((k) => (
                  <option key={k} value={k}>
                    {t(`ops.operations.kinds.${k}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="op-agency">{t('ops.operations.agencyId')}</Label>
              <Input id="op-agency" name="agencyId" aria-describedby="op-agency-hint" autoComplete="off" />
              <span id="op-agency-hint" className="text-xs text-muted-foreground">
                {t('ops.operations.agencyIdHint')}
              </span>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="op-reason">{t('ops.operations.reason')}</Label>
              <textarea
                id="op-reason"
                name="reason"
                required
                minLength={10}
                maxLength={500}
                rows={2}
                aria-describedby="op-reason-hint"
                className="rounded-md border bg-background p-2 text-sm"
              />
              <span id="op-reason-hint" className="text-xs text-muted-foreground">
                {t('ops.operations.reasonHint')}
              </span>
            </div>
            <fieldset className="grid gap-3 rounded-md border p-3 sm:col-span-2 sm:grid-cols-2">
              <legend className="px-1 text-sm">{t('ops.operations.replayTitle')}</legend>
              <div className="flex flex-col gap-1">
                <Label htmlFor="op-since">{t('ops.operations.since')}</Label>
                <Input id="op-since" name="since" type="datetime-local" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="op-until">{t('ops.operations.until')}</Label>
                <Input id="op-until" name="until" type="datetime-local" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="op-type">{t('ops.operations.eventType')}</Label>
                <Input id="op-type" name="eventType" autoComplete="off" maxLength={100} />
              </div>
              <label className="flex items-center gap-2 self-end text-sm">
                <input type="checkbox" name="deadOnly" />
                {t('ops.operations.deadOnly')}
              </label>
            </fieldset>
            <Button type="submit" className="self-start">
              {t('ops.operations.start')}
            </Button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="op-list" className="flex flex-col gap-3">
        <h2 id="op-list" className="text-lg font-semibold">
          {t('ops.operations.listTitle')}
        </h2>
        {!res.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.generic')}
          </p>
        ) : res.data.items.length === 0 ? (
          <EmptyState title={t('ops.operations.empty')} />
        ) : (
          <ul className="divide-y rounded-md border" data-testid="staff-operations">
            {res.data.items.map((op) => (
              <OperationRow key={op.id} op={op} canRun={canRun} t={t} format={format} />
            ))}
          </ul>
        )}
        {res.ok && res.data.nextCursor ? (
          <Link
            href={{ pathname: '/staff/operations', query: { cursor: res.data.nextCursor } }}
            className="text-sm underline-offset-4 hover:underline"
          >
            {t('queue.next')}
          </Link>
        ) : null}
      </section>
    </div>
  );
}

type StaffT = Awaited<ReturnType<typeof getTranslations<'staff'>>>;
type Formatter = Awaited<ReturnType<typeof getFormatter>>;

function OperationRow({
  op,
  canRun,
  t,
  format,
}: {
  op: StaffOperationDto;
  canRun: boolean;
  t: StaffT;
  format: Formatter;
}) {
  const active = op.state === 'QUEUED' || op.state === 'RUNNING';
  const percent = op.total ? Math.min(100, Math.round((op.done / op.total) * 100)) : null;
  return (
    <li className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t(`ops.operations.kinds.${op.kind}`)}</span>
        <span className="text-xs text-muted-foreground">
          {t(`ops.operations.states.${op.state}`)}
          {op.cancelRequested && active ? ` · ${t('ops.operations.cancelRequested')}` : ''}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {op.agencyId ? (
          <Link href={`/staff/tenants/${op.agencyId}`} className="underline-offset-4 hover:underline">
            {op.agencyId}
          </Link>
        ) : (
          t('ops.operations.allAgencies')
        )}
        {' · '}
        {t('ops.operations.created', {
          date: format.dateTime(new Date(op.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
        })}
      </p>
      {/* Staff-entered text (operators only): rendered as text. */}
      {op.reason !== null ? <p className="whitespace-pre-wrap text-xs">{op.reason}</p> : null}
      <div className="flex items-center gap-3">
        <progress
          className="h-2 w-48"
          max={op.total ?? undefined}
          value={op.total ? op.done : undefined}
          aria-label={t(`ops.operations.kinds.${op.kind}`)}
        />
        <span className="text-xs tabular-nums" data-testid="op-progress">
          {op.total !== null
            ? `${t('ops.operations.progress', { done: format.number(op.done), total: format.number(op.total) })}${percent !== null ? ` (${percent}%)` : ''}`
            : t('ops.operations.progressOpen', { done: format.number(op.done) })}
        </span>
        {canRun && active && !op.cancelRequested ? (
          <form action={cancelOperationAction}>
            <input type="hidden" name="id" value={op.id} />
            <Button type="submit" size="sm" variant="outline">
              {t('ops.operations.cancel')}
            </Button>
          </form>
        ) : null}
      </div>
      {op.errorCode ? <p className="font-mono text-xs text-destructive">{op.errorCode}</p> : null}
    </li>
  );
}
