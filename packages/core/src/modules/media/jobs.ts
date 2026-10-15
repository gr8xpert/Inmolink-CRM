import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { mediaEvents } from './events';
import * as repo from './repo';

/** An object nothing references any more is deleted this long after its last reference went (S3-03). */
export const MEDIA_DELETE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * media worker jobs (PATTERNS §12), pool `media`. Idempotent, per-tenant fair share.
 *
 * `media.syncObjects` (one per `media.object.referencesChanged` event): records the objects a request verified
 * in storage (`media_objects`, insert-if-missing) and recounts the references of every object in the event —
 * a count, not an increment, so a repeated, late or reordered delivery writes the same truth. At zero
 * references `delete_after` is set `MEDIA_DELETE_GRACE_DAYS` ahead; the orphan cleanup (S3-04) deletes the
 * object after that unless a new reference cleared it.
 */
export const mediaJobs = {
  syncObjects: defineJob({
    name: 'media.syncObjects',
    pool: 'media',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      objects: mediaEvents.referencesChanged.schema.shape.objects,
    }),
    jobId: (p) => `media.sync:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const deleteAt = new Date(clock.now().getTime() + MEDIA_DELETE_GRACE_DAYS * DAY_MS);
      const updated = await withSystem('media.syncObjects', async (tx) => {
        await repo.insertObjects(
          tx,
          p.objects.flatMap((o) => (o.upload ? [{ sha256: o.sha256, ...o.upload }] : [])),
        );
        return repo.recount(
          tx,
          p.objects.map((o) => o.sha256),
          deleteAt,
        );
      });
      // An object the platform never recorded (its upload event not processed yet) is counted on that event.
      log.info({ objects: p.objects.length, updated }, 'media objects recounted');
    },
  }),
};
