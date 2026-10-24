import { subscribe } from '@inmolink/platform/outbox';
import * as mls from '../mls';
import { chatEvents } from './events';
import { chatJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/** Viewing request changes after which its thread is read-only. */
const CLOSING: ReadonlySet<string> = new Set(['DECLINED', 'CANCELLED', 'EXPIRED']);

/**
 * Outbox → chat worker (called once by the worker). Each event becomes its job (job ID = the event's id). The tenant
 * is `meta.agencyId` (RLS-checked when the event was written): the sender's, reader's or opener's agency.
 */
export function registerChatSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      chatEvents.messageSent,
      (payload, meta) =>
        chatJobs.deliverMessage.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          threadId: payload.threadId,
          messageId: payload.messageId,
          createdMs: meta.createdAt.getTime(),
        }),
      { name: 'chat.message.deliver' },
    ),
    subscribe(
      chatEvents.threadRead,
      (payload, meta) =>
        chatJobs.pushRead.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          threadId: payload.threadId,
          userId: payload.userId,
          at: payload.at,
        }),
      { name: 'chat.thread.read' },
    ),
    subscribe(
      chatEvents.viewingThreadOpened,
      (payload, meta) =>
        chatJobs.seatViewingThread.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          threadId: payload.threadId,
        }),
      { name: 'chat.viewingThread.seat' },
    ),
    // a declined, cancelled or expired viewing request makes its thread read-only
    subscribe(
      mls.mlsEvents.viewingChanged,
      async (payload, meta) => {
        if (!CLOSING.has(payload.action)) return;
        await chatJobs.closeViewingThread.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          requestId: payload.requestId,
        });
      },
      { name: 'chat.viewingThread.close' },
    ),
  ];
}

export function unregisterChatSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
