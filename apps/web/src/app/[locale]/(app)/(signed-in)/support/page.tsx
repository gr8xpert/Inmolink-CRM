import { SupportTicketCategory, SupportTicketPriority } from '@inmolink/contracts';
import { Button, EmptyState, Input, Label } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchSupportTickets } from '@/server/support-api';
import { createTicketAction } from './actions';

const ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED', 'generic'] as const;

/** Support (S13-05, PLAN §7 M21): the agency's tickets, newest first, and a form to open a new one. */
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const params = await searchParams;
  const cursor =
    typeof params.cursor === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(params.cursor) ? params.cursor : undefined;
  const res = await fetchSupportTickets(sessionRef(session.user), { cursor });
  if (res === 'revoked') redirect('/session/expired');
  const t = await getTranslations('support');
  const format = await getFormatter();
  const error = ERRORS.find((e) => e === params.error);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <section aria-labelledby="new-ticket" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="new-ticket" className="font-medium">
          {t('create.title')}
        </h2>
        <form action={createTicketAction} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-subject">{t('create.subject')}</Label>
            <Input id="ticket-subject" name="subject" required minLength={3} maxLength={200} />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="ticket-category">{t('create.category')}</Label>
              <select
                id="ticket-category"
                name="category"
                defaultValue="OTHER"
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {SupportTicketCategory.options.map((c) => (
                  <option key={c} value={c}>
                    {t(`categories.${c}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="ticket-priority">{t('create.priority')}</Label>
              <select
                id="ticket-priority"
                name="priority"
                defaultValue="NORMAL"
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {SupportTicketPriority.options.map((p) => (
                  <option key={p} value={p}>
                    {t(`priorities.${p}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-body">{t('create.body')}</Label>
            <textarea
              id="ticket-body"
              name="body"
              required
              maxLength={10000}
              rows={6}
              className="rounded-md border bg-background p-2 text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('create.attachHint')}</p>
          <Button type="submit" className="self-start">
            {t('create.submit')}
          </Button>
        </form>
      </section>

      <section aria-labelledby="ticket-list" className="flex flex-col gap-2">
        <h2 id="ticket-list" className="font-medium">
          {t('list.title')}
        </h2>
        {!res.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {res.status === 403 ? t('errors.FORBIDDEN') : t('errors.generic')}
          </p>
        ) : res.data.items.length === 0 ? (
          <EmptyState title={t('list.empty')} />
        ) : (
          <ul className="divide-y rounded-md border" data-testid="support-tickets">
            {res.data.items.map((ticket) => (
              <li key={ticket.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <Link
                    href={`/support/${ticket.id}`}
                    className="truncate font-medium underline-offset-4 hover:underline"
                  >
                    {ticket.subject}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {t(`categories.${ticket.category}`)} · {t(`priorities.${ticket.priority}`)} ·{' '}
                    {t('list.updated', { date: date(ticket.lastMessageAt) })}
                  </p>
                </div>
                <span className="rounded-full bg-muted px-3 py-1 text-xs">{t(`status.${ticket.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
        {res.ok && res.data.nextCursor ? (
          <Link
            href={{ pathname: '/support', query: { cursor: res.data.nextCursor } }}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('list.next')}
          </Link>
        ) : null}
      </section>
    </div>
  );
}
