import { NOTIFICATION_LIMITS } from '@inmolink/contracts';
import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * notifications events (PATTERNS §8), emitted in the transaction that raised the notifications. IDs only.
 *
 * - `notifications.notification.created` — one `notify` call's notifications (one per recipient, ≤ 100): `at` is their
 *   time (epoch ms, the partition key), `inApp` whether the feed shows it (push it live), `email` whether it waits for
 *   the e-mail digest. Subscribers: `notifications.pushRealtime` (the recipients' sockets) and
 *   `notifications.sendDigest` (throttled 5 minutes per recipient).
 */
export const notificationsEvents = {
  created: defineEvent(
    'notifications.notification.created',
    1,
    z.object({
      agencyId: z.uuid(),
      items: z
        .array(
          z.object({
            id: z.uuid(),
            userId: z.uuid(),
            at: z.number().int(),
            inApp: z.boolean(),
            email: z.boolean(),
          }),
        )
        .min(1)
        .max(NOTIFICATION_LIMITS.recipients),
    }),
  ),
};
