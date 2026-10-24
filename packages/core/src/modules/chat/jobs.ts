import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { closeViewingThread, deliverMessage, pushRead, seatViewingThread } from './delivery';

/**
 * chat worker jobs (PATTERNS §12). Idempotent, per-tenant fair share (the event's agency). Job ID = the outbox event's
 * id: a redelivered event adds nothing.
 *
 * - `chat.deliverMessage` — the message to every participant's sockets (both agencies; at least once), then the
 *   `CHAT_MESSAGE` notifications (→ the notifications module's 5-minute e-mail digest; idempotent). One load.
 * - `chat.pushRead` — a read receipt to every participant's sockets.
 * - `chat.seatViewingThread` — a new viewing thread's default members on both sides, and its subject.
 * - `chat.closeViewingThread` — a declined, cancelled or expired viewing request's thread becomes read-only.
 *
 * Pools (S11 review): the live pushes (`deliverMessage`, `pushRead`) run in `realtime` with `notifications.pushRealtime` —
 * the live-push lane, which no mail or digest burst shares (digests have their own `digest` pool); seating and closing
 * viewing threads run in `email` (the delivery pool).
 */
export const chatJobs = {
  deliverMessage: defineJob({
    name: 'chat.deliverMessage',
    pool: 'realtime',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      threadId: z.uuid(),
      messageId: z.uuid(),
      createdMs: z.number().int(),
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    timeoutMs: 30_000,
    async run(p) {
      return deliverMessage(p, { eventId: p.eventId, createdAt: new Date(p.createdMs) });
    },
  }),

  pushRead: defineJob({
    name: 'chat.pushRead',
    pool: 'realtime',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      threadId: z.uuid(),
      userId: z.uuid(),
      at: z.number().int(),
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
    timeoutMs: 30_000,
    async run(p) {
      return pushRead(p);
    },
  }),

  seatViewingThread: defineJob({
    name: 'chat.seatViewingThread',
    pool: 'email',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), threadId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return seatViewingThread(p);
    },
  }),

  closeViewingThread: defineJob({
    name: 'chat.closeViewingThread',
    pool: 'email',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), requestId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return closeViewingThread(p);
    },
  }),
};
