import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchColleagues, fetchThreads } from '@/server/chat-api';
import { inClientMode, isActingAsMember } from '@/server/nav';
import { loadShell } from '@/server/shell';
import { startDirectChatAction } from './actions';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

/**
 * The chat inbox (S12-F1, PLAN §7 M12): the member's threads — direct, viewing-request and network-board replies —
 * newest activity first, unread ones marked. Server-rendered; a thread opens at `/chat/:id`.
 */
export default async function ChatInboxPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const clientShell = await loadShell();
  if (clientShell && inClientMode(clientShell.identity)) return <ClientModeUnavailable />;
  const q = await searchParams;
  const cursor = q.cursor && CURSOR.test(q.cursor) ? q.cursor : undefined;
  const t = await getTranslations('chat');
  const format = await getFormatter();
  const res = await fetchThreads(sessionRef(session.user), { limit: 25, cursor });
  if (res === 'revoked') redirect('/session/expired');
  // Staff acting as a member cannot write in their name (chat policy), so no way to start a chat is offered then.
  const acting = clientShell ? isActingAsMember(clientShell.identity) : false;
  const members = acting ? null : await fetchColleagues(sessionRef(session.user));
  if (members === 'revoked') redirect('/session/expired');
  const colleagues = members?.ok
    ? members.data.items.filter((m) => m.status === 'ACTIVE' && m.userId !== session.user.id)
    : [];
  const errorCode = q.error;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {members?.ok ? (
        colleagues.length === 0 ? (
          <p data-testid="chat-no-colleagues" className="text-sm text-muted-foreground">
            {t('newChat.noColleagues')}
          </p>
        ) : (
          <form action={startDirectChatAction} className="flex flex-wrap items-end gap-2" data-testid="chat-new">
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <label htmlFor="chat-new-user" className="text-sm font-medium">
                {t('newChat.label')}
              </label>
              <select
                id="chat-new-user"
                name="userId"
                required
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {colleagues.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              {t('newChat.submit')}
            </button>
          </form>
        )
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {errorCode === 'VALIDATION_FAILED' ? t('errors.VALIDATION_FAILED') : t('newChat.failed')}
        </p>
      ) : null}
      {!res.ok ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      ) : res.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="divide-y rounded-md border">
          {res.data.items.map((th) => (
            <li key={th.id} data-testid="chat-thread">
              <Link href={`/chat/${th.id}`} className="flex flex-wrap items-center gap-3 p-3 text-sm hover:bg-accent">
                <div className="flex min-w-60 flex-1 flex-col">
                  <span className={th.unread ? 'font-semibold' : 'font-medium'}>
                    {th.title ?? th.subject ?? th.peerAgency?.name ?? (th.colleagues.join(', ') || t('untitled'))}
                  </span>
                  <span className="text-muted-foreground">
                    {[t(`kinds.${th.kind}`), th.peerAgency?.name, th.closed ? t('closed') : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                {th.unread ? <span className="rounded border px-1.5 text-xs">{t('unread')}</span> : null}
                <span className="text-muted-foreground">
                  {format.dateTime(new Date(th.lastMessageAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {res.ok && res.data.nextCursor ? (
        <Link
          href={{ pathname: '/chat', query: { cursor: res.data.nextCursor } }}
          className="text-sm underline underline-offset-4"
        >
          {t('more')}
        </Link>
      ) : null}
    </div>
  );
}
