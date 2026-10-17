/**
 * developments worker jobs (PATTERNS §12): `defineJob({ name: 'developments.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 *
 * Development document hygiene (S4-F4), pool `maintenance` (the general worker reaches the private bucket):
 *
 * `developments.deleteDocumentObject` (one per `developments.document.deleted` event): deletes the object; a
 * failed delete throws and BullMQ retries it with backoff, so a storage outage delays the delete instead of
 * leaking the PDF. A delete of a missing object succeeds, so a repeated run writes the same truth.
 *
 * `developments.sweepOrphanDocuments` (schedule: every hour): `development-documents/` objects older than an hour
 * that no `development_documents` row names — a crash between store and record, a cascade from a removed
 * development — are deleted. One query per listed page.
 */
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { z } from 'zod';
import { DEVELOPMENT_DOCUMENTS_PREFIX, developmentDocumentKey } from './documents';
import type { developmentsEvents } from './events';
import * as repo from './repo';

/** An object this young may still be between "stored" and "recorded" in an upload: leave it alone. */
export const DEVELOPMENT_DOCUMENT_ORPHAN_MIN_AGE_MS = 60 * 60_000;
const LIST_PAGE = 500;
/** Pages per run (100k objects): bounds one run; the next run continues. */
const MAX_PAGES = 200;
const STORAGE_CONCURRENCY = 16;

/** Runs `fn` over `items` with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export const developmentsJobs = {
  deleteDocumentObject: defineJob({
    name: 'developments.deleteDocumentObject',
    pool: 'maintenance',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      developmentId: z.uuid(),
      documentId: z.uuid(),
    }),
    jobId: (p) => `developments.deleteDocument:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 8,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      await storage().delete('private', developmentDocumentKey(p.agencyId, p.developmentId, p.documentId));
    },
  }),

  sweepOrphanDocuments: defineJob({
    name: 'developments.sweepOrphanDocuments',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const cutoff = clock.now().getTime() - DEVELOPMENT_DOCUMENT_ORPHAN_MIN_AGE_MS;
      let scanned = 0;
      let deleted = 0;
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES && !signal.aborted; page++) {
        const listed = await storage().list('private', DEVELOPMENT_DOCUMENTS_PREFIX, { limit: LIST_PAGE, after });
        scanned += listed.objects.length;
        const old = listed.objects.filter((o) => o.lastModified.getTime() <= cutoff).map((o) => o.key);
        const known = await withSystem('developments.sweepOrphanDocuments', (tx) => repo.existingDocumentKeys(tx, old));
        const garbage = old.filter((k) => !known.has(k));
        await eachLimit(garbage, STORAGE_CONCURRENCY, (k) => storage().delete('private', k));
        deleted += garbage.length;
        if (!listed.next) break;
        after = listed.next;
      }
      log.info({ scanned, deleted }, 'orphan development documents swept');
      return { scanned, deleted };
    },
  }),
};

/** The outbox event's handler: one delete job per deleted document. */
export const enqueueDocumentDelete = (
  payload: z.infer<typeof developmentsEvents.documentDeleted.schema>,
  meta: { eventId: string; agencyId: string },
) =>
  developmentsJobs.deleteDocumentObject.enqueue({
    eventId: meta.eventId,
    agencyId: meta.agencyId,
    developmentId: payload.developmentId,
    documentId: payload.documentId,
  });
