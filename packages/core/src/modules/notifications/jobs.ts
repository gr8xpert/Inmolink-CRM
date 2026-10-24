import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { DIGEST_DELAY_MS, pushNotifications, sendDigest } from './service';

export { DIGEST_DELAY_MS };

/**
 * notifications worker jobs (PATTERNS §12). Idempotent, per-tenant fair share.
 *
 * - `notifications.pushRealtime` (pool `realtime`, the live-push lane with `chat.deliverMessage` and `chat.pushRead`:
 *   queue age p95 < 30 s, PLAN §9; one per `notifications.notification.created` event, job ID = the event's id): the
 *   event's unread in-app notifications go to their recipients' sockets (redis-cache pub/sub → apps/realtime). At
 *   least once: a retry pushes again, clients drop ids they already have.
 * - `notifications.sendDigest` (pool `digest`, its own queue, slots and fair-share backlogs — S11 review: a broad
 *   network post queues thousands of digests, which must never delay a live push or the `email` pool's mail; per
 *   member, throttled: the first notification of a quiet member starts a 5-minute window, later ones join it —
 *   enqueue with `{ throttleMs: DIGEST_DELAY_MS }`): one e-mail with what is still unread and whose type still has
 *   e-mail on, at least 5 minutes old. Idempotent by its claim in the database (`email_pending`); younger ones waiting
 *   queue the next run for when they are due. No per-process cap: the pool's concurrency is the bound, so a burst
 *   waits in its queue instead of bouncing through delayed.
 */
export const notificationsJobs = {
  pushRealtime: defineJob({
    name: 'notifications.pushRealtime',
    pool: 'realtime',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      items: z
        .array(z.object({ id: z.uuid(), at: z.number().int() }))
        .min(1)
        .max(100),
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
    timeoutMs: 30_000,
    async run(p) {
      return pushNotifications(p);
    },
  }),

  sendDigest: defineJob({
    name: 'notifications.sendDigest',
    pool: 'digest',
    payload: z.object({ agencyId: z.uuid(), userId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const result = await sendDigest(p);
      // younger notifications (or a second batch) still wait: their digest when they are due
      if (result.retryInMs !== null) await notificationsJobs.sendDigest.enqueue(p, { delayMs: result.retryInMs });
      if (result.sent) log.info({ mailed: result.mailed }, 'notification digest sent');
      return result;
    },
  }),
};
