import { subscribe } from '@inmolink/platform/outbox';
import { mediaEvents } from './events';
import { mediaJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → reference counting (S3-03): each `media.object.referencesChanged` event becomes one
 * `media.syncObjects` job (stable job ID = event ID; the job itself is idempotent). The tenant is
 * `meta.agencyId` (RLS-checked when the event was written), the fair-share group. Called once by the worker.
 */
export function registerMediaSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      mediaEvents.referencesChanged,
      (payload, meta) =>
        mediaJobs.syncObjects.enqueue({ eventId: meta.eventId, agencyId: meta.agencyId, objects: payload.objects }),
      { name: 'media.objects.sync' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterMediaSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
