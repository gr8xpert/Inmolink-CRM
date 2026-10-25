import { SUPPORT_ATTACHMENT_MAX_COUNT, SUPPORT_ATTACHMENT_TYPES, SupportTicketParams } from '@inmolink/contracts';
import { Button, EmptyState, Label } from '@inmolink/ui';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchSupportTicket } from '@/server/support-api';
import { openAttachmentAction, replyAction, resolveAction } from '../actions';

const NOTICES = ['created', 'replied', 'resolved', 'uploaded'] as const;
const ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_LIMIT_REACHED',
  'generic',
] as const;

/**
 * One support ticket (S13-05): the conversation (staff replies signed by the support team; internal notes never
 * reach this page — the API does not return them), attachments, reply and resolve.
 */
export default async function SupportTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const parsed = SupportTicketParams.safeParse({ id: (await params).id });
  if (!parsed.success) notFound();
  const query = await searchParams;
  const before =
    typeof query.before === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(query.before) ? query.before : undefined;
  const res = await fetchSupportTicket(sessionRef(session.user), parsed.data.id, before);
  if (res === 'revoked') redirect('/session/expired');
  if (!res.ok && res.status === 404) notFound();
  const t = await getTranslations('support');
  const format = await getFormatter();
  const notice = NOTICES.find((n) => n === query.notice);
  const error = ERRORS.find((e) => e === query.error);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  if (!res.ok) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {res.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
        </p>
      </div>
    );
  }
  const ticket = res.data;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Link href="/support" className="text-sm underline-offset-4 hover:underline">
        {t('ticket.back')}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{ticket.subject}</h1>
        <p className="text-sm text-muted-foreground">
          {t(`categories.${ticket.category}`)} · {t(`priorities.${ticket.priority}`)} ·{' '}
          {t('ticket.opened', { date: date(ticket.createdAt) })} · {t(`status.${ticket.status}`)}
        </p>
      </header>
      {notice ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {t(`notices.${notice}`)}
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
              href={{ pathname: `/support/${ticket.id}`, query: { before: ticket.olderMessagesCursor } }}
              className="underline-offset-4 hover:underline"
            >
              {t('ticket.older')}
            </Link>
          ) : null}
          {before ? (
            <Link href={`/support/${ticket.id}`} className="underline-offset-4 hover:underline">
              {t('ticket.latest')}
            </Link>
          ) : null}
        </nav>
      ) : null}
      <ol className="flex flex-col gap-3" data-testid="support-messages">
        {ticket.messages.map((m) => (
          <li key={m.id} className={`rounded-md border p-3 text-sm ${m.author === 'STAFF' ? 'bg-muted' : ''}`}>
            <p className="text-xs font-medium">
              {m.author === 'STAFF' ? t('ticket.supportTeam') : m.authorName} · {date(m.createdAt)}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
          </li>
        ))}
      </ol>

      <section aria-labelledby="attachments-heading" className="flex flex-col gap-2">
        <h2 id="attachments-heading" className="font-medium">
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
        {ticket.attachments.length < SUPPORT_ATTACHMENT_MAX_COUNT ? (
          // A route handler, not a server action: only this path accepts 10 MB bodies.
          <form
            action={`/api/support/tickets/${ticket.id}/attachments`}
            method="post"
            encType="multipart/form-data"
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
          >
            <input type="hidden" name="locale" value={locale} />
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="support-file">{t('attachments.upload')}</Label>
              <input
                id="support-file"
                name="file"
                type="file"
                required
                accept={SUPPORT_ATTACHMENT_TYPES.join(',')}
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">{t('attachments.hint')}</p>
            </div>
            <Button type="submit" variant="outline">
              {t('attachments.uploadSubmit')}
            </Button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="reply-heading" className="flex flex-col gap-2">
        <h2 id="reply-heading" className="font-medium">
          {t('ticket.reply')}
        </h2>
        {ticket.status === 'RESOLVED' ? (
          <p className="text-sm text-muted-foreground">{t('ticket.resolvedNote')}</p>
        ) : null}
        <form action={replyAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={ticket.id} />
          <Label htmlFor="reply-body" className="sr-only">
            {t('ticket.reply')}
          </Label>
          <textarea
            id="reply-body"
            name="body"
            required
            maxLength={10000}
            rows={4}
            className="rounded-md border bg-background p-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{t('ticket.replySubmit')}</Button>
          </div>
        </form>
        {ticket.status !== 'RESOLVED' ? (
          <form action={resolveAction}>
            <input type="hidden" name="id" value={ticket.id} />
            <Button type="submit" variant="outline">
              {t('ticket.resolve')}
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
