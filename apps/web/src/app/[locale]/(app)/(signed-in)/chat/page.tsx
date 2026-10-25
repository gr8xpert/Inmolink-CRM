import { EmptyState } from '@inmolink/ui';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchThreads } from '@/server/chat-api';

const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

/**
 * The chat inbox (S12-F1, PLAN §7 M12): the member's threads — direct, viewing-request and network-board replies —
 * newest activity first, unread ones marked. Server-rendered; a thread opens at `/chat/:id`.
 */
export default async function ChatInboxPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const q = await searchParams;
  const cursor = q.cursor && CURSOR.test(q.cursor) ? q.cursor : undefined;
  const t = await getTranslations('chat');
  const format = await getFormatter();
  const res = await fetchThreads(sessionRef(session.user), { limit: 25, cursor });
  if (res === 'revoked') redirect('/session/expired');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
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
                    {th.title ?? th.subject ?? th.peerAgency?.name ?? t('untitled')}
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
