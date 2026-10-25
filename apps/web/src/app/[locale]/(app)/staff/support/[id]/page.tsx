import { SupportTicketParams, SupportTicketPriority, SupportTicketStatus } from '@inmolink/contracts';
import { Button, EmptyState, Label } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaff } from '@/server/staff';
import { fetchStaffSupportTicket } from '@/server/support-api';
import { openAttachmentAction, postMessageAction, updateTicketAction } from '../actions';

const NOTICES = ['posted', 'noted', 'updated'] as const;
const ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED', 'generic'] as const;
/** Mirrors the API (`staff.support.write`); the API decides. */
const WRITERS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'STAFF_SUPPORT']);

/**
 * One support ticket for staff (S13-05): the conversation with internal notes marked, attachments, reply or note,
 * and triage (status, priority, assignment).
 */
export default async function StaffSupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { session, me } = await requireStaff();
  const parsed = SupportTicketParams.safeParse({ id: (await params).id });
  if (!parsed.success) notFound();
  const query = await searchParams;
  const before =
    typeof query.before === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(query.before) ? query.before : undefined;
  const res = await fetchStaffSupportTicket(session, parsed.data.id, before);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && (res.status === 403 || res.status === 404)) notFound();
  const t = await getTranslations('support');
  const format = await getFormatter();
  const notice = NOTICES.find((n) => n === query.notice);
  const error = ERRORS.find((e) => e === query.error);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  if (!res.ok) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('errors.generic')}
      </p>
    );
  }
  const ticket = res.data;
  const canWrite = WRITERS.has(me.role);
  const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm';

  return (
    <div className="flex flex-col gap-6">
      <Link href="/staff/support" className="text-sm underline-offset-4 hover:underline">
        {t('staff.back')}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{ticket.subject}</h1>
        <p className="text-sm text-muted-foreground">
          {t('staff.agency')}:{' '}
          <Link href={`/staff/tenants/${ticket.agency.id}`} className="underline-offset-4 hover:underline">
            {ticket.agency.name}
          </Link>{' '}
          · {t(`categories.${ticket.category}`)} · {t(`priorities.${ticket.priority}`)} · {t(`status.${ticket.status}`)}{' '}
          · {ticket.assigneeUserId ? t('staff.assigned') : t('staff.unassigned')}
        </p>
      </header>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`staff.notices.${notice}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {before || ticket.olderMessagesCursor ? (
        <nav className="flex gap-4 text-sm">
          {ticket.olderMessagesCursor ? (
            <Link
              href={{ pathname: `/staff/support/${ticket.id}`, query: { before: ticket.olderMessagesCursor } }}
              className="underline-offset-4 hover:underline"
            >
              {t('ticket.older')}
            </Link>
          ) : null}
          {before ? (
            <Link href={`/staff/support/${ticket.id}`} className="underline-offset-4 hover:underline">
              {t('ticket.latest')}
            </Link>
          ) : null}
        </nav>
      ) : null}
      <ol className="flex flex-col gap-3" data-testid="staff-support-messages">
        {ticket.messages.map((m) => (
          <li
            key={m.id}
            className={`rounded-md border p-3 text-sm ${m.internal ? 'border-dashed bg-amber-50 dark:bg-amber-950' : m.author === 'STAFF' ? 'bg-muted' : ''}`}
          >
            <p className="text-xs font-medium">
              {m.authorName} · {date(m.createdAt)}
              {m.internal ? (
                <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] uppercase">
                  {t('staff.internalBadge')}
                </span>
              ) : null}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
          </li>
        ))}
      </ol>

      <section aria-labelledby="staff-attachments" className="flex flex-col gap-2">
        <h2 id="staff-attachments" className="font-medium">
          {t('attachments.title')}
        </h2>
        {ticket.attachments.length === 0 ? (
          <EmptyState title={t('attachments.empty')} />
        ) : (
          <ul className="divide-y rounded-md border">
            {ticket.attachments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span className="truncate">
                  {a.fileName} · {format.number(a.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB
                </span>
                <form action={openAttachmentAction}>
                  <input type="hidden" name="id" value={ticket.id} />
                  <input type="hidden" name="attachmentId" value={a.id} />
                  <Button type="submit" variant="outline" size="sm">
                    {t('attachments.open')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canWrite ? (
        <>
          <section aria-labelledby="staff-reply" className="flex flex-col gap-2">
            <h2 id="staff-reply" className="font-medium">
              {t('staff.replyTitle')}
            </h2>
            <form action={postMessageAction} className="flex flex-col gap-2">
              <input type="hidden" name="id" value={ticket.id} />
              <Label htmlFor="staff-body">{t('staff.body')}</Label>
              <textarea
                id="staff-body"
                name="body"
                required
                maxLength={10000}
                rows={4}
                className="rounded-md border bg-background p-2 text-sm"
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="internal" />
                {t('staff.internal')}
              </label>
              <p className="text-xs text-muted-foreground">{t('staff.internalHint')}</p>
              <Button type="submit" className="self-start">
                {t('staff.submit')}
              </Button>
            </form>
          </section>

          <section aria-labelledby="staff-triage" className="flex flex-col gap-2">
            <h2 id="staff-triage" className="font-medium">
              {t('staff.triageTitle')}
            </h2>
            <form action={updateTicketAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="id" value={ticket.id} />
              <div className="flex flex-col gap-2">
                <Label htmlFor="triage-status">{t('staff.status')}</Label>
                <select id="triage-status" name="status" defaultValue="" className={selectClass}>
                  <option value="">{t('staff.keep')}</option>
                  {SupportTicketStatus.options.map((s) => (
                    <option key={s} value={s}>
                      {t(`status.${s}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="triage-priority">{t('staff.priority')}</Label>
                <select id="triage-priority" name="priority" defaultValue="" className={selectClass}>
                  <option value="">{t('staff.keep')}</option>
                  {SupportTicketPriority.options.map((p) => (
                    <option key={p} value={p}>
                      {t(`priorities.${p}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="triage-assignee">{t('staff.assignee')}</Label>
                <select id="triage-assignee" name="assignee" defaultValue="" className={selectClass}>
                  <option value="">{t('staff.keep')}</option>
                  <option value="ME">{t('staff.assignMe')}</option>
                  <option value="NONE">{t('staff.release')}</option>
                </select>
              </div>
              <Button type="submit" variant="outline">
                {t('staff.save')}
              </Button>
            </form>
          </section>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('staff.readOnly')}</p>
      )}
    </div>
  );
}
