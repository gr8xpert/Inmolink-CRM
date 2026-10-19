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
 * development — are deleted. One query per listed page. A run stops at its page cap (100k keys) and saves the last
 * key it listed (`job_checkpoints`, S5-F2); the next run resumes after it, and one that reaches the end clears it,
 * so the following run wraps to the start.
 *
 * `developments.purgeDeletedDevelopments` (S5-F2, schedule: every hour, all agencies via `withSystem`):
 * developments soft-deleted more than `DEVELOPMENT_RETENTION_DAYS` ago are deleted for good (phases, units, price
 * lists, documents' rows: FK cascade) with one `developments.document.deleted` per document, so
 * `deleteDocumentObject` removes each object as for a single delete (the listing purge's shape, S4-F3). A transaction
 * takes up to `PURGE_BATCH` developments but at most `PURGE_UNIT_BUDGET` units (S6-F3): a development with more units
 * first loses them `PURGE_UNIT_BUDGET` per transaction. A run that ends with work left queues a continuation.
 * Idempotent: a purged development is gone; a lost delete job leaves an object the orphan sweep removes.
 */
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import { defineJob, readCheckpoint, writeCheckpoint } from '@inmolink/platform/queue';
import { storage } from '@inmolink/platform/storage';
import { z } from 'zod';
import { DEVELOPMENT_DOCUMENTS_PREFIX, developmentDocumentKey } from './documents';
import { developmentsEvents } from './events';
import * as repo from './repo';

/** An object this young may still be between "stored" and "recorded" in an upload: leave it alone. */
export const DEVELOPMENT_DOCUMENT_ORPHAN_MIN_AGE_MS = 60 * 60_000;
const LIST_PAGE = 500;
/** Pages per run (100k objects): bounds one run; the next run continues. */
const MAX_PAGES = 200;
const STORAGE_CONCURRENCY = 16;
/** Soft-deleted developments stay this long before the purge removes them (as listings, S4-F3). */
export const DEVELOPMENT_RETENTION_DAYS = 30;
/** Developments purged per transaction, and at most this many transactions per run (a continuation follows). */
const PURGE_BATCH = 100;
const PURGE_MAX_BATCHES = 20;
/** Units deleted per purge transaction at most (S6-F3): their histories cascade with them. */
export const PURGE_UNIT_BUDGET = 5_000;

/** A sweep's bounds: the schedule passes none; tests make the page cap small. */
const sweepPayload = z
  .object({
    pageSize: z.number().int().min(1).max(1_000).optional(),
    maxPages: z.number().int().min(1).max(MAX_PAGES).optional(),
  })
  .strict();

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
    payload: sweepPayload,
    every: 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(p, { log, signal }) {
      const name = 'developments.sweepOrphanDocuments';
      const cutoff = clock.now().getTime() - DEVELOPMENT_DOCUMENT_ORPHAN_MIN_AGE_MS;
      let scanned = 0;
      let deleted = 0;
      let last = await withSystem(name, (tx) => readCheckpoint(tx, name));
      let end = false;
      for (let page = 0; page < (p.maxPages ?? MAX_PAGES) && !signal.aborted; page++) {
        const listed = await storage().list('private', DEVELOPMENT_DOCUMENTS_PREFIX, {
          limit: p.pageSize ?? LIST_PAGE,
          startAfter: last,
        });
        scanned += listed.objects.length;
        const old = listed.objects.filter((o) => o.lastModified.getTime() <= cutoff).map((o) => o.key);
        const known = await withSystem(name, (tx) => repo.existingDocumentKeys(tx, old));
        const garbage = old.filter((k) => !known.has(k));
        await eachLimit(garbage, STORAGE_CONCURRENCY, (k) => storage().delete('private', k));
        deleted += garbage.length;
        last = listed.objects.at(-1)?.key ?? last;
        if (!listed.next) {
          end = true;
          break;
        }
      }
      // Cut short: the next run resumes after the last key; at the end it wraps to the start.
      await withSystem(name, (tx) => writeCheckpoint(tx, name, end ? null : (last ?? null)));
      log.info({ scanned, deleted, end }, 'orphan development documents swept');
      return { scanned, deleted, end };
    },
  }),

  purgeDeletedDevelopments: defineJob({
    name: 'developments.purgeDeletedDevelopments',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      let purged = 0;
      let unitsDeleted = 0;
      let maxUnitsPerTransaction = 0;
      let more = false;
      for (let i = 0; i < PURGE_MAX_BATCHES && !signal.aborted; i++) {
        const step = await purgeStep();
        purged += step.purged;
        unitsDeleted += step.units;
        maxUnitsPerTransaction = Math.max(maxUnitsPerTransaction, step.units);
        more = step.more;
        if (!more) break;
      }
      // Queue I/O after the commits: work is left, so continue now, not in an hour.
      if (more && !signal.aborted) await developmentsJobs.purgeDeletedDevelopments.enqueue({});
      if (purged + unitsDeleted > 0) log.info({ purged, unitsDeleted, more }, 'soft-deleted developments purged');
      return { purged, more, unitsDeleted, maxUnitsPerTransaction };
    },
  }),
};

/**
 * One purge transaction (S6-F3): the due developments that fit `PURGE_UNIT_BUDGET` units together are deleted; when
 * the first due one alone has more, only `PURGE_UNIT_BUDGET` of its units go. `more`: due work is left.
 */
async function purgeStep(): Promise<{ purged: number; units: number; more: boolean }> {
  return withSystem('developments.purgeDeletedDevelopments', async (tx) => {
    const before = new Date(clock.now().getTime() - DEVELOPMENT_RETENTION_DAYS * 86_400_000);
    const due = await repo.dueForPurge(tx, before, PURGE_BATCH);
    if (due.length === 0) return { purged: 0, units: 0, more: false };
    const counts = await repo.unitCountsOf(
      tx,
      due.map((d) => d.id),
    );
    const fits: string[] = [];
    let units = 0;
    for (const d of due) {
      const n = counts.get(d.id) ?? 0;
      if (units + n > PURGE_UNIT_BUDGET) break;
      fits.push(d.id);
      units += n;
    }
    const first = due[0] as { id: string };
    if (fits.length === 0) {
      // Too large for one transaction: its units go first, a budget at a time (it stays due, locked by none).
      const n = await repo.deleteUnitsOfDeleted(tx, first.id, PURGE_UNIT_BUDGET);
      return { purged: 0, units: n, more: true };
    }
    const documents = await repo.documentsOfDevelopments(tx, fits);
    const deleted = await repo.purge(tx, fits);
    const kept = new Set(deleted.map((d) => d.id));
    // The rows are gone with the development: each object leaves storage like a single delete, under its agency.
    const byAgency = new Map<string, OutboxMessage[]>();
    for (const d of documents) {
      if (!kept.has(d.developmentId)) continue;
      const messages = byAgency.get(d.agencyId) ?? [];
      messages.push(
        developmentsEvents.documentDeleted({
          documentId: d.id,
          developmentId: d.developmentId,
          agencyId: d.agencyId,
        }),
      );
      byAgency.set(d.agencyId, messages);
    }
    for (const [agencyId, messages] of byAgency) await emit(tx, messages, { agencyId });
    return { purged: deleted.length, units, more: due.length === PURGE_BATCH || fits.length < due.length };
  });
}

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
