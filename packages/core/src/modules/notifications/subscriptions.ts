import { subscribe } from '@inmolink/platform/outbox';
import { notificationsEvents } from './events';
import { DIGEST_DELAY_MS, notificationsJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → notifications worker (called once by the worker). Each `notifications.notification.created` event becomes
 * one `notifications.pushRealtime` job (job ID = the event's id: a redelivered event adds nothing) when any of its
 * notifications shows in-app, and one throttled `notifications.sendDigest` per recipient waiting for e-mail (the
 * window's job absorbs the rest). The tenant is `meta.agencyId` (RLS-checked when the event was written).
 */
export function registerNotificationsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      notificationsEvents.created,
      async (payload, meta) => {
        const items = payload.items.filter((i) => i.inApp).map((i) => ({ id: i.id, at: i.at }));
        if (items.length === 0) return;
        await notificationsJobs.pushRealtime.enqueue({ eventId: meta.eventId, agencyId: meta.agencyId, items });
      },
      { name: 'notifications.push' },
    ),
    subscribe(
      notificationsEvents.created,
      async (payload, meta) => {
        const users = [...new Set(payload.items.filter((i) => i.email).map((i) => i.userId))];
        if (users.length === 0) return;
        await notificationsJobs.sendDigest.enqueueMany(
          users.map((userId) => ({
            payload: { agencyId: meta.agencyId, userId },
            options: { throttleMs: DIGEST_DELAY_MS },
          })),
        );
      },
      { name: 'notifications.digest' },
    ),
  ];
}

export function unregisterNotificationsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
