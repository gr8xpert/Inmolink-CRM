/**
 * Listing document hygiene (S3-F8), pool `maintenance`: the private bucket's `documents/` prefix is the general
 * worker's (S3-F7: the media container's storage user cannot reach it). Idempotent; a delete of a missing object
 * succeeds, so a repeated or late run writes the same truth.
 *
 * `media.deleteDocumentObject` (one per `media.document.deleted` event): deletes the object; a failed delete throws
 * and BullMQ retries it with backoff, so a storage outage delays the delete instead of leaking the PDF.
 *
 * `media.purgeDocuments` (`requestDocumentPurge`, after a listing purge or an agency offboarding): deletes every
 * object under `documents/<agency>/<listing>/` or `documents/<agency>/`, a page at a time; re-queues itself while
 * a page limit cut it short.
 *
 * `media.sweepOrphanDocuments` (schedule: every hour): `documents/` objects older than an hour that no
 * `listing_documents` row names — a crash between store and record, a cascade from a deleted listing — are
 * deleted. One query per listed page.
 */
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { z } from 'zod';
import { DOCUMENTS_PREFIX, documentKey } from './documents';
import type { mediaEvents } from './events';
import * as repo from './repo';
import { mapLimit } from './service';

/** An object this young may still be between "stored" and "recorded" in an upload: leave it alone. */
export const DOCUMENT_ORPHAN_MIN_AGE_MS = 60 * 60_000;
const LIST_PAGE = 500;
/** Pages per run (100k objects): bounds one run; the next run (or the re-queued purge) continues. */
const MAX_PAGES = 200;
const STORAGE_CONCURRENCY = 16;

const purgePayload = z.object({
  agencyId: z.uuid(),
  /** One listing's documents; the whole agency's when null (offboarding). */
  listingId: z.uuid().nullable(),
  /** What asked for it (part of the job ID): a purge job's run or event ID. */
  trigger: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});

const purgePrefix = (p: { agencyId: string; listingId: string | null }) =>
  `${DOCUMENTS_PREFIX}${p.agencyId}/${p.listingId ? `${p.listingId}/` : ''}`;

/**
 * The next run's trigger, so its job id differs from the running one (S3 review): `<base>-c<n>` counts the
 * continuations — a fixed suffix stopped changing once the trigger hit its length cap, and BullMQ drops a job
 * whose id is still in use.
 */
export function continuationTrigger(trigger: string): string {
  const m = /^(.*)-c(\d+)$/.exec(trigger);
  const base = m ? (m[1] as string) : trigger;
  const n = m ? Number(m[2]) + 1 : 1;
  return `${base.slice(0, 48)}-c${n}`;
}

export const mediaDocumentJobs = {
  deleteDocumentObject: defineJob({
    name: 'media.deleteDocumentObject',
    pool: 'maintenance',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      listingId: z.uuid(),
      documentId: z.uuid(),
    }),
    jobId: (p) => `media.deleteDocument:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 8,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      await storage().delete('private', documentKey(p.agencyId, p.listingId, p.documentId));
    },
  }),

  purgeDocuments: defineJob({
    name: 'media.purgeDocuments',
    pool: 'maintenance',
    payload: purgePayload,
    jobId: (p) => `media.purgeDocuments:${p.agencyId}:${p.listingId ?? 'agency'}:${p.trigger}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log, signal }) {
      const prefix = purgePrefix(p);
      let deleted = 0;
      let more = false;
      // Deleting while listing: always list from the start, what is gone is not listed again.
      for (let page = 0; page < MAX_PAGES && !signal.aborted; page++) {
        const listed = await storage().list('private', prefix, { limit: LIST_PAGE });
        await mapLimit(listed.objects, STORAGE_CONCURRENCY, (o) => storage().delete('private', o.key));
        deleted += listed.objects.length;
        more = Boolean(listed.next);
        if (!more) break;
      }
      if (more) await mediaDocumentJobs.purgeDocuments.enqueue({ ...p, trigger: continuationTrigger(p.trigger) });
      log.info({ deleted, more }, 'listing documents purged');
      return { deleted, more };
    },
  }),

  sweepOrphanDocuments: defineJob({
    name: 'media.sweepOrphanDocuments',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const cutoff = clock.now().getTime() - DOCUMENT_ORPHAN_MIN_AGE_MS;
      let scanned = 0;
      let deleted = 0;
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES && !signal.aborted; page++) {
        const listed = await storage().list('private', DOCUMENTS_PREFIX, { limit: LIST_PAGE, after });
        scanned += listed.objects.length;
        const old = listed.objects.filter((o) => o.lastModified.getTime() <= cutoff).map((o) => o.key);
        const known = await withSystem('media.sweepOrphanDocuments', (tx) => repo.existingDocumentKeys(tx, old));
        const garbage = old.filter((k) => !known.has(k));
        await mapLimit(garbage, STORAGE_CONCURRENCY, (k) => storage().delete('private', k));
        deleted += garbage.length;
        if (!listed.next) break;
        after = listed.next;
      }
      log.info({ scanned, deleted }, 'orphan listing documents swept');
      return { scanned, deleted };
    },
  }),
};

/**
 * Deletes a purged listing's documents (`listingId`) or an offboarded agency's (`listingId: null`) from storage.
 * The caller — the listing purge or the offboarding job — calls it after its transaction committed (queue I/O:
 * never inside one); the rows go with the listing (FK cascade). Idempotent per `trigger`.
 */
export async function requestDocumentPurge(input: z.input<typeof purgePayload>): Promise<void> {
  await mediaDocumentJobs.purgeDocuments.enqueue(purgePayload.parse(input));
}

/** The outbox event's handler: one delete job per deleted document. */
export const enqueueDocumentDelete = (
  payload: z.infer<typeof mediaEvents.documentDeleted.schema>,
  meta: { eventId: string; agencyId: string },
) => mediaDocumentJobs.deleteDocumentObject.enqueue({ eventId: meta.eventId, agencyId: meta.agencyId, ...payload });
