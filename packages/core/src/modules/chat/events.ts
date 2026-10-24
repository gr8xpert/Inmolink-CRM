import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * chat events (PATTERNS §8), emitted with `emit(ctx.tx, …)` in the same transaction. IDs only — never a message's text.
 *
 * - `chat.message.sent` — a member's message (the sender agency's event; the other agency's copy was appended in the
 *   same statement). Subscribers: `chat.deliverMessage` (every participant's sockets, both agencies) and
 *   `chat.notifyMessage` (a `CHAT_MESSAGE` notification for each participant with nothing unread yet → the 5-minute
 *   e-mail digest of the notifications module).
 * - `chat.thread.read` — a participant read a thread up to `at` (epoch ms). Subscriber: `chat.pushRead` (read receipt).
 * - `chat.viewingThread.opened` — the first copy of a viewing request's thread. Subscriber: `chat.seatViewingThread`
 *   (both sides' default members and the listing's reference).
 */
export const chatEvents = {
  messageSent: defineEvent(
    'chat.message.sent',
    1,
    z.object({ threadId: z.uuid(), messageId: z.uuid(), at: z.number().int() }),
  ),
  threadRead: defineEvent(
    'chat.thread.read',
    1,
    z.object({ threadId: z.uuid(), userId: z.uuid(), at: z.number().int() }),
  ),
  viewingThreadOpened: defineEvent('chat.viewingThread.opened', 1, z.object({ threadId: z.uuid() })),
};
