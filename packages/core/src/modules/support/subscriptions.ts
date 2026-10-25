import { subscribe } from '@inmolink/platform/outbox';
import { supportEvents } from './events';
import { supportJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/** Outbox → `support.sendMessageEmail` (S13-05), one job per event. Called once by the worker; idempotent. */
export function registerSupportSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      supportEvents.messagePosted,
      (payload, meta) =>
        supportJobs.sendMessageEmail.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          messageId: payload.messageId,
          isNew: payload.isNew,
        }),
      { name: 'support.email.message' },
    ),
  ];
}

export function unregisterSupportSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
