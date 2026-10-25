'use client';

import { useEffect, useRef, useState } from 'react';
import { connectRealtime } from '@/components/realtime/connect';

/** One message as the API sends it (the fields the list shows). */
export interface ThreadMessage {
  id: string;
  threadId: string;
  sender: { name: string; ownAgency: boolean };
  body: string;
}

interface Props {
  threadId: string;
  /** Oldest first. */
  initial: ThreadMessage[];
  /** Participant user id → name, for the typing indicator. */
  names: Record<string, string>;
  realtimeUrl: string;
  /** Namespace and event names come from the contracts, passed by the server so zod stays out of the client bundle. */
  wire: { namespace: string; message: string; typing: string; join: string; leave: string; typingOut: string };
  /** The send form's server action; null when the thread is closed. */
  sendAction: ((form: FormData) => Promise<void>) | null;
  /** Marks the thread read once it is on screen (a server action: opening a page does not write). */
  markRead: (threadId: string) => Promise<void>;
  clientKey: string;
  labels: { empty: string; typing: string; placeholder: string; send: string };
}

/** The typing indicator disappears after this long without another signal. */
const TYPING_SHOW_MS = 4_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A `message` push, checked by shape: the server validated it; this only keeps a bad frame from breaking the list. */
function asMessage(raw: unknown): ThreadMessage | null {
  if (!isRecord(raw) || !isRecord(raw.message)) return null;
  const m = raw.message;
  if (typeof m.id !== 'string' || typeof m.threadId !== 'string' || typeof m.body !== 'string') return null;
  if (!isRecord(m.sender) || typeof m.sender.name !== 'string' || typeof m.sender.ownAgency !== 'boolean') return null;
  return {
    id: m.id,
    threadId: m.threadId,
    body: m.body,
    sender: { name: m.sender.name, ownAgency: m.sender.ownAgency },
  };
}

/**
 * The messages of one thread, live (S12-F1), and its send form: new messages and the typing indicator arrive over
 * Socket.io (`/chat`), loaded on demand so it stays out of the first-load JS. Without a socket (offline, blocked) the
 * page is the server's render and a reload shows the rest — sending is a plain form post.
 */
export function ThreadLive({
  threadId,
  initial,
  names,
  realtimeUrl,
  wire,
  sendAction,
  markRead,
  clientKey,
  labels,
}: Props) {
  const [messages, setMessages] = useState(initial);
  const [typing, setTyping] = useState<string | null>(null);
  const socketRef = useRef<{ emit: (event: string, data: unknown) => void } | null>(null);
  // Read inside socket handlers only: a new `names` object from a refresh must not reconnect the socket.
  const namesRef = useRef(names);
  namesRef.current = names;

  // A new server render (after sending) replaces the list.
  useEffect(() => {
    setMessages(initial);
  }, [initial]);

  // Opening the thread reads it.
  useEffect(() => {
    void markRead(threadId);
  }, [markRead, threadId]);

  useEffect(() => {
    let closed = false;
    let socket: Awaited<ReturnType<typeof connectRealtime>> = null;
    let hide: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      socket = await connectRealtime(realtimeUrl, wire.namespace);
      if (!socket) return;
      if (closed) {
        socket.disconnect();
        return;
      }
      socketRef.current = socket;
      socket.on('connect', () => socket?.emit(wire.join, { threadId }));
      socket.on(wire.message, (raw: unknown) => {
        const m = asMessage(raw);
        if (!m || m.threadId !== threadId) return;
        setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
        setTyping(null);
      });
      socket.on(wire.typing, (raw: unknown) => {
        if (!isRecord(raw) || raw.threadId !== threadId || typeof raw.userId !== 'string') return;
        setTyping(namesRef.current[raw.userId] || '…');
        clearTimeout(hide);
        hide = setTimeout(() => setTyping(null), TYPING_SHOW_MS);
      });
    })();
    return () => {
      closed = true;
      clearTimeout(hide);
      socket?.emit(wire.leave, { threadId });
      socket?.disconnect();
      socketRef.current = null;
    };
  }, [threadId, realtimeUrl, wire.namespace, wire.join, wire.leave, wire.message, wire.typing]);

  return (
    <div className="flex flex-col gap-2">
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {messages.map((m) => (
            <li
              key={m.id}
              data-testid="chat-message"
              className={`max-w-[85%] rounded-md border p-2 text-sm ${m.sender.ownAgency ? 'self-end' : 'self-start'}`}
            >
              <p className="text-xs text-muted-foreground">{m.sender.name}</p>
              <p className="whitespace-pre-line">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="h-4 text-xs text-muted-foreground" aria-live="polite" data-testid="typing">
        {typing ? labels.typing.replace('{name}', typing) : ''}
      </p>
      {sendAction ? (
        <form action={sendAction} className="flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="threadId" value={threadId} />
          <input type="hidden" name="clientKey" value={clientKey} />
          <label className="flex min-w-60 flex-1 flex-col gap-1">
            <span className="sr-only">{labels.placeholder}</span>
            <textarea
              name="body"
              required
              maxLength={4000}
              rows={2}
              placeholder={labels.placeholder}
              onInput={() => socketRef.current?.emit(wire.typingOut, { threadId })}
              className="rounded-md border bg-background px-2 py-1"
            />
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 font-medium">
            {labels.send}
          </button>
        </form>
      ) : null}
    </div>
  );
}
