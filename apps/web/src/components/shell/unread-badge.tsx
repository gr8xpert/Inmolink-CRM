'use client';

import { useEffect, useState } from 'react';
import { connectRealtime } from '@/components/realtime/connect';

/**
 * The bell's unread count (S12-F1): the server's number at render, then +1 for each notification pushed over the
 * `/notifications` socket (Socket.io loads on demand, after first paint). Marking read happens on the notifications
 * page, which reloads the shell's number.
 */
export function UnreadBadge({
  initial,
  realtimeUrl,
  unreadLabel,
  socket: wire,
}: {
  initial: { count: number; capped: boolean } | null;
  realtimeUrl: string | null;
  unreadLabel: string;
  /** Namespace, event name and display cap come from the contracts, passed by the server so zod stays out of every page's JS. */
  socket: { namespace: string; event: string; cap: number };
}) {
  const [count, setCount] = useState(initial?.count ?? 0);
  const [capped, setCapped] = useState(initial?.capped ?? false);
  useEffect(() => {
    setCount(initial?.count ?? 0);
    setCapped(initial?.capped ?? false);
  }, [initial]);

  useEffect(() => {
    if (!realtimeUrl || !initial) return;
    let closed = false;
    let socket: Awaited<ReturnType<typeof connectRealtime>> = null;
    (async () => {
      socket = await connectRealtime(realtimeUrl, wire.namespace);
      if (!socket) return;
      if (closed) {
        socket.disconnect();
        return;
      }
      socket.on(wire.event, () => {
        setCount((c) => {
          if (c + 1 > wire.cap) setCapped(true);
          return Math.min(c + 1, wire.cap);
        });
      });
    })();
    return () => {
      closed = true;
      socket?.disconnect();
    };
  }, [realtimeUrl, initial, wire.namespace, wire.event, wire.cap]);

  if (count === 0 && !capped) return null;
  return (
    <span
      data-testid="unread-badge"
      className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground"
    >
      <span aria-hidden="true">{capped ? `${wire.cap}+` : count}</span>
      <span className="sr-only">{unreadLabel.replace('{count}', capped ? `${wire.cap}+` : String(count))}</span>
    </span>
  );
}
