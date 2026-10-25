import { randomUUID } from 'node:crypto';
import { REALTIME_CHAT_CLIENT_EVENTS, REALTIME_CHAT_EVENTS, REALTIME_CHAT_NAMESPACE } from '@inmolink/contracts';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { Link, redirect as localeRedirect } from '@/i18n/navigation';
import { sessionRef } from '@/server/api';
import { fetchMessages, fetchThread } from '@/server/chat-api';
import { webConfig } from '@/server/env';
import { markThreadReadAction, sendMessageAction } from '../actions';
import { ThreadLive } from './thread-live';

const ERRORS = ['generic', 'VALIDATION_FAILED', 'FORBIDDEN', 'RATE_LIMITED', 'CHAT_THREAD_CLOSED'] as const;

/** The only hand-off targets a link may open: WhatsApp's share page and a mail client. */
const WHATSAPP = /^https:\/\/wa\.me\/(\?[^\s#]*)?$/;
const safeHandoff = (href: string, kind: 'whatsapp' | 'email') =>
  kind === 'whatsapp' ? WHATSAPP.test(href) : href.startsWith('mailto:');

/**
 * One chat thread (S12-F1, PLAN §7 M12): the messages (oldest first), a send form that works without JavaScript, the
 * WhatsApp / e-mail handoff links the API builds, and — in viewing threads — the warning that the other agency
 * must never learn the client. The live island (typing indicator, new messages) loads Socket.io on demand and marks
 * the thread read once it is on screen.
 */
export default async function ChatThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const locale = await getLocale();
  const session = await auth();
  if (!session?.user?.id) return localeRedirect({ href: '/login', locale });
  const { id } = await params;
  const q = await searchParams;
  const error = ERRORS.find((e) => e === q.error);
  const t = await getTranslations('chat');
  const ref = sessionRef(session.user);
  const [thread, messages] = await Promise.all([fetchThread(ref, id), fetchMessages(ref, id, { limit: 100 })]);
  if (thread === 'revoked' || messages === 'revoked') redirect('/session/expired');
  if (!thread.ok) {
    if (thread.status === 404 || thread.status === 400) notFound();
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('errors.load')}
        </p>
      </div>
    );
  }
  const config = await webConfig();
  const th = thread.data;
  const initial = messages.ok ? [...messages.data.items].reverse() : [];
  const names = Object.fromEntries(th.participants.map((p) => [p.userId, p.name ?? '']));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{th.title ?? th.subject ?? th.peerAgency?.name ?? t('untitled')}</h1>
        <Link href="/chat" className="text-sm underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {[t(`kinds.${th.kind}`), th.peerAgency?.name, th.closed ? t('closed') : null].filter(Boolean).join(' · ')}
      </p>
      {th.kind === 'VIEWING' ? (
        <p
          role="note"
          data-testid="viewing-warning"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          {t('viewingWarning')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <ThreadLive
        threadId={th.id}
        initial={initial}
        names={names}
        realtimeUrl={config.REALTIME_PUBLIC_URL}
        wire={{
          namespace: REALTIME_CHAT_NAMESPACE,
          message: REALTIME_CHAT_EVENTS.message,
          typing: REALTIME_CHAT_EVENTS.typing,
          join: REALTIME_CHAT_CLIENT_EVENTS.join,
          leave: REALTIME_CHAT_CLIENT_EVENTS.leave,
          typingOut: REALTIME_CHAT_CLIENT_EVENTS.typing,
        }}
        sendAction={th.closed ? null : sendMessageAction}
        markRead={markThreadReadAction}
        clientKey={randomUUID()}
        labels={{ empty: t('noMessages'), typing: t('typing'), placeholder: t('placeholder'), send: t('send') }}
      />

      <div className="flex flex-wrap gap-3 text-sm">
        {safeHandoff(th.handoff.whatsappUrl, 'whatsapp') ? (
          <a
            href={th.handoff.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            {t('handoff.whatsapp')}
          </a>
        ) : null}
        {safeHandoff(th.handoff.emailUrl, 'email') ? (
          <a href={th.handoff.emailUrl} className="underline underline-offset-4">
            {t('handoff.email')}
          </a>
        ) : null}
      </div>
    </div>
  );
}
