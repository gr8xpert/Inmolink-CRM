import { subscribe } from '@inmolink/platform/outbox';
import { mediaEvents } from './events';
import { mediaJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → media worker. Each `media.object.referencesChanged` event becomes one `media.syncObjects` job
 * (reference counting, S3-03; stable job ID = event ID) and one `media.processObject` job per object the request
 * verified as a new upload (S3-04; job ID = pipeline + hash + event: a later upload of the same file runs again,
 * and the job skips what is done). The tenant is `meta.agencyId` (RLS-checked when the event was written), the fair-share
 * group. Called once by the worker.
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
    subscribe(
      mediaEvents.referencesChanged,
      async (payload, meta) => {
        await Promise.all(
          payload.objects.flatMap((o) =>
            o.upload
              ? [
                  mediaJobs.processObject.enqueue({
                    sha256: o.sha256,
                    agencyId: meta.agencyId,
                    upload: o.upload,
                    trigger: meta.eventId,
                  }),
                ]
              : [],
          ),
        );
      },
      { name: 'media.objects.process' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterMediaSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
