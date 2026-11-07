import { randomUUID } from 'node:crypto';
import { DEAL_DOCUMENT_KINDS, DEAL_DOCUMENT_MAX_BYTES, type DealDto } from '@inmolink/contracts';
import { Button, EmptyState } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { OpenFileForm } from '@/components/open-file-form';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchDeal, fetchDealDisputes, fetchDealDocuments, fetchDealTasks } from '@/server/deals-api';
import { inClientMode, isActingAsMember } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { ActionButton } from '../../collaborations/action-button';
import {
  addDealTaskAction,
  advanceDealAction,
  confirmDealAction,
  disputeDealAction,
  fallThroughDealAction,
  openDealChatAction,
  openDealDocumentAction,
  removeDealDocumentAction,
  setDealPriceAction,
  withdrawDealAction,
} from '../actions';
import { CommissionBreakdown, type Formatters, Handshake, StageTimeline, targetText } from '../deal-parts';
import { advanceTargets, isUuid, noticeOf } from '../query';
import { CollaborationAgreement } from './collaboration-agreement';

const SECTION = 'flex flex-col gap-3 rounded-md border p-4';
const FIELD = 'h-9 rounded-md border bg-background px-2';
const SUMMARY = 'w-fit cursor-pointer text-sm font-medium underline-offset-4 hover:underline';
const CLOSED = new Set<DealDto['stage']>(['COMPLETION', 'FELL_THROUGH']);

/**
 * One deal's room (R2-04c, PLAN §3 #10, §7 M10): the stage timeline, the price and the commission from the terms
 * snapshot, the completion handshake, and the moves the API takes from this member now (`allowedActions`); the deal's
 * documents (both parties'), the agency's own tasks about it, its chat thread with the other party, and the agency's
 * disputes for staff mediation; the collaboration agreement and its signatures (R2-05c). Plain forms to server actions; the only client JS is the shared submit button and the
 * file opener. Every rule is the API's.
 */
export default async function DealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const shell = await loadShell();
  if (shell && inClientMode(shell.identity)) return <ClientModeUnavailable />;
  const acting = shell ? isActingAsMember(shell.identity) : false;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ref = sessionRef(session.user);
  const [res, docs, tasks, disputes] = await Promise.all([
    fetchDeal(ref, id),
    fetchDealDocuments(ref, id),
    fetchDealTasks(ref, id),
    fetchDealDisputes(ref, id),
  ]);
  if (res === 'revoked' || docs === 'revoked' || tasks === 'revoked' || disputes === 'revoked') {
    redirect('/session/expired');
  }
  if (!res.ok && (res.status === 404 || res.error?.code === 'DEAL_NOT_FOUND')) notFound();

  const t = await getTranslations('network.deals');
  const format = await getFormatter();
  const q = await searchParams;
  const tr = (key: string, values?: Record<string, string | number>) => t(key as never, values as never);
  const f: Formatters = {
    t: tr,
    money: (cents, currency) => format.number(cents / 100, { style: 'currency', currency, maximumFractionDigits: 2 }),
    percent: (bp) => format.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 2 }),
    date: (iso) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
  };
  const done = noticeOf(q.done);
  const error = typeof q.error === 'string' ? q.error : null;
  const reason = typeof q.reason === 'string' ? q.reason : null;
  const errorText = (code: string) =>
    code === 'DEAL_STATE' && reason && t.has(`errors.states.${reason}` as never)
      ? t(`errors.states.${reason}` as never)
      : t.has(`errors.${code}` as never)
        ? t(`errors.${code}` as never)
        : t('errors.generic');

  if (!res.ok) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
        <p role="alert" className="text-sm text-destructive">
          {errorText(res.error?.code ?? 'load')}
        </p>
      </div>
    );
  }
  const deal = res.data;
  const has = (a: DealDto['allowedActions'][number]) => deal.allowedActions.includes(a);
  const closed = CLOSED.has(deal.stage);
  const dealField = <input type="hidden" name="dealId" value={deal.id} />;
  const ownDisputes = disputes.ok ? disputes.data.items : [];
  const openDispute = ownDisputes.find((d) => d.status === 'OPEN');
  const maxMb = String(DEAL_DOCUMENT_MAX_BYTES / 1024 / 1024);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <Link href="/deals" className="text-sm underline-offset-4 hover:underline">
        {t('back')}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{targetText(tr, deal)}</h1>
        <p className="text-sm text-muted-foreground">
          {t(`parties.${deal.party}`)} · {t('with', { agency: deal.counterpartName ?? t('unknownAgency') })}
        </p>
      </header>

      {done ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`done.${done}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
      {acting ? <p className="text-sm text-muted-foreground">{t('actingReadOnly')}</p> : null}

      <section aria-labelledby="h-stage" className={SECTION}>
        <h2 id="h-stage" className="text-base font-semibold">
          {t('sections.stage')}
        </h2>
        <StageTimeline deal={deal} t={tr} date={f.date} />
        {has('ADVANCE') ? (
          <form action={advanceDealAction} className="flex flex-wrap items-center gap-2 text-sm">
            {dealField}
            <span>{t('advance.label')}</span>
            {advanceTargets(deal.stage).map((s) => (
              <ActionButton
                key={s}
                name="stage"
                value={s}
                label={t('advance.to', { stage: t(`stages.${s}`) })}
                confirm={t('advance.confirm', { stage: t(`stages.${s}`) })}
              />
            ))}
          </form>
        ) : null}
        {has('FALL_THROUGH') ? (
          <details>
            <summary className={SUMMARY}>{t('fallThrough.open')}</summary>
            <form action={fallThroughDealAction} className="mt-2 flex flex-col gap-2 text-sm">
              {dealField}
              <label className="flex flex-col gap-1">
                <span>{t('fallThrough.reason')}</span>
                <textarea name="reason" required maxLength={2000} rows={2} className="rounded-md border p-2" />
              </label>
              <p className="text-muted-foreground">{t('fallThrough.note')}</p>
              <div>
                <ActionButton label={t('fallThrough.submit')} confirm={t('fallThrough.confirm')} />
              </div>
            </form>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="h-money" className={SECTION}>
        <h2 id="h-money" className="text-base font-semibold">
          {t('sections.money')}
        </h2>
        <CommissionBreakdown deal={deal} {...f} />
        {has('SET_PRICE') ? (
          <details>
            <summary className={SUMMARY}>{t('price.change')}</summary>
            <form action={setDealPriceAction} className="mt-2 flex flex-wrap items-end gap-2 text-sm">
              {dealField}
              <input type="hidden" name="currency" value={deal.price.currency} />
              <label className="flex flex-col gap-1">
                <span>{t('price.new', { currency: deal.price.currency })}</span>
                <input name="amount" required inputMode="decimal" autoComplete="off" className={FIELD} />
              </label>
              <ActionButton label={t('price.submit')} />
              <p className="basis-full text-muted-foreground">{t('price.note')}</p>
            </form>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="h-handshake" className={SECTION}>
        <h2 id="h-handshake" className="text-base font-semibold">
          {t('sections.handshake')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('handshake.intro')}</p>
        <Handshake deal={deal} t={tr} date={f.date} />
        {has('CONFIRM') || has('WITHDRAW') ? (
          <div className="flex flex-wrap gap-2">
            {has('CONFIRM') ? (
              <form action={confirmDealAction}>
                {dealField}
                <input type="hidden" name="seenCents" value={deal.price.amountCents} />
                <input type="hidden" name="currency" value={deal.price.currency} />
                <ActionButton
                  variant="default"
                  label={t('handshake.confirm', { price: f.money(deal.price.amountCents, deal.price.currency) })}
                  confirm={t('handshake.confirmAsk', {
                    price: f.money(deal.price.amountCents, deal.price.currency),
                  })}
                />
              </form>
            ) : null}
            {has('WITHDRAW') ? (
              <form action={withdrawDealAction}>
                {dealField}
                <ActionButton label={t('handshake.withdraw')} confirm={t('handshake.withdrawAsk')} />
              </form>
            ) : null}
          </div>
        ) : null}
        {!closed && deal.allowedActions.length === 0 && !acting ? (
          <p className="text-sm text-muted-foreground">{t('bindHint')}</p>
        ) : null}
      </section>

      <section aria-labelledby="h-documents" className={SECTION}>
        <h2 id="h-documents" className="text-base font-semibold">
          {t('sections.documents')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('documents.intro')}</p>
        {!docs.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.load')}
          </p>
        ) : docs.data.items.length === 0 ? (
          <EmptyState title={t('documents.empty')} />
        ) : (
          <ul className="flex flex-col divide-y text-sm" data-testid="deal-documents">
            {docs.data.items.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className={d.removedAt ? 'line-through' : 'font-medium'}>{d.fileName}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    {[
                      t(`documents.kinds.${d.kind}`),
                      `${format.number(Math.ceil(d.sizeBytes / 1024))} KB`,
                      d.uploadedBy.ownAgency ? d.uploadedBy.name : t('documents.byOther', { name: d.uploadedBy.name }),
                      f.date(d.createdAt),
                    ].join(' · ')}
                    {d.removedAt ? ` · ${t('documents.removedAt', { date: f.date(d.removedAt) })}` : ''}
                  </span>
                </span>
                {d.removedAt ? null : (
                  <span className="flex gap-1">
                    <OpenFileForm action={openDealDocumentAction}>
                      {dealField}
                      <input type="hidden" name="documentId" value={d.id} />
                      <Button type="submit" variant="outline" size="sm">
                        {t('documents.open')}
                      </Button>
                    </OpenFileForm>
                    {d.uploadedBy.ownAgency && !closed && !acting ? (
                      <form action={removeDealDocumentAction}>
                        {dealField}
                        <input type="hidden" name="documentId" value={d.id} />
                        <ActionButton
                          label={t('documents.remove')}
                          confirm={t('documents.removeAsk', { name: d.fileName })}
                        />
                      </form>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!closed && !acting ? (
          // A route handler, not a server action: only that path accepts 20 MB bodies.
          <form
            action={`/api/deals/${deal.id}/documents`}
            method="post"
            encType="multipart/form-data"
            className="flex flex-col gap-2 text-sm sm:flex-row sm:items-end"
          >
            <input type="hidden" name="locale" value={locale} />
            <label className="flex flex-col gap-1">
              <span>{t('documents.kind')}</span>
              <select name="kind" defaultValue="OTHER" className={FIELD}>
                {DEAL_DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`documents.kinds.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span>{t('documents.file', { max: maxMb })}</span>
              <input type="file" name="file" required accept="application/pdf,.pdf" className="text-sm" />
            </label>
            <Button type="submit" variant="outline" size="sm">
              {t('documents.upload')}
            </Button>
          </form>
        ) : null}
      </section>

      <CollaborationAgreement session={ref} deal={deal} locale={locale} acting={acting} query={q} />

      <section aria-labelledby="h-tasks" className={SECTION}>
        <h2 id="h-tasks" className="text-base font-semibold">
          {t('sections.tasks')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('tasks.intro')}</p>
        {!tasks.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {t('errors.load')}
          </p>
        ) : tasks.data.items.length === 0 ? (
          <EmptyState title={t('tasks.empty')} />
        ) : (
          <ul className="flex flex-col divide-y text-sm" data-testid="deal-tasks">
            {tasks.data.items.map((task) => (
              <li key={task.id} className="flex justify-between gap-2 py-2">
                <span>{task.title}</span>
                <span className="text-xs text-muted-foreground">
                  {task.dueAt ? f.date(task.dueAt) : t('tasks.noDue')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/tasks" className="self-start text-sm underline-offset-4 hover:underline">
          {t('tasks.all')}
        </Link>
        {acting ? null : (
          <form action={addDealTaskAction} className="flex flex-col gap-2 text-sm sm:flex-row sm:items-end">
            {dealField}
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <label className="flex flex-1 flex-col gap-1">
              <span>{t('tasks.title')}</span>
              <input name="title" required maxLength={200} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{t('tasks.due')}</span>
              <input name="dueAt" type="datetime-local" className={FIELD} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="remind" defaultChecked />
              <span>{t('tasks.remind')}</span>
            </label>
            <ActionButton label={t('tasks.add')} />
          </form>
        )}
      </section>

      <section aria-labelledby="h-chat" className={SECTION}>
        <h2 id="h-chat" className="text-base font-semibold">
          {t('sections.chat')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('chat.intro')}</p>
        {acting ? null : (
          <form action={openDealChatAction}>
            {dealField}
            <ActionButton label={t('chat.open')} />
          </form>
        )}
      </section>

      <section aria-labelledby="h-disputes" className={SECTION}>
        <h2 id="h-disputes" className="text-base font-semibold">
          {t('sections.disputes')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('disputes.intro')}</p>
        {ownDisputes.length > 0 ? (
          <ul className="flex flex-col gap-2 text-sm" data-testid="deal-disputes">
            {ownDisputes.map((d) => (
              <li key={d.id} className="rounded-md bg-muted/40 p-2">
                <p>
                  <span className="font-medium">{t(`disputes.statuses.${d.status}`)}</span> · {f.date(d.createdAt)}
                </p>
                <p>{d.reason}</p>
                {d.resolutionNote ? (
                  <p className="text-muted-foreground">
                    {t('disputes.note')}: {d.resolutionNote}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {has('DISPUTE') && !openDispute ? (
          <details>
            <summary className={SUMMARY}>{t('disputes.open')}</summary>
            <form action={disputeDealAction} className="mt-2 flex flex-col gap-2 text-sm">
              {dealField}
              <label className="flex flex-col gap-1">
                <span>{t('disputes.reason')}</span>
                <textarea name="reason" required maxLength={2000} rows={3} className="rounded-md border p-2" />
              </label>
              <p className="text-muted-foreground">{t('disputes.hint')}</p>
              <div>
                <ActionButton label={t('disputes.submit')} confirm={t('disputes.confirm')} />
              </div>
            </form>
          </details>
        ) : null}
      </section>
    </div>
  );
}
