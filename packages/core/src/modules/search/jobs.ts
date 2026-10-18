import { withSystem } from '@inmolink/db';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { checkIndexDrift, repairIndex, syncIndex } from './indexer';
import { rebuildAllReadModels, rebuildDevelopmentReadModels, rebuildReadModels } from './service';

/** Bursts of changes to one target (autosave, a batch of photos) collapse into one rebuild this long after the last. */
export const READ_MODEL_DEBOUNCE_MS = 2_000;
/** Images still processing: look again this long later, at most this many times (processing is not an event). */
const PENDING_RECHECK_MS = 60_000;
export const READ_MODEL_PENDING_RECHECKS = 10;
/** A read-model change reaches the index this long after it was written (at most; a throttle, not a debounce). */
export const INDEX_SYNC_THROTTLE_MS = 500;

const ReadModelKind = z.enum(['LISTING', 'UNIT']);

/**
 * search worker jobs (PATTERNS §12), pool `indexing`. Idempotent (a rebuild reads current state and never moves a
 * read model backwards), per-tenant fair share (`meta.agencyId`).
 *
 * `search.buildReadModel` (from listing, media and unit events, debounced per target): rebuilds one listing's or
 * unit's documents, or drops them when it has none any more. While images are still processing it queues itself
 * again a minute later (≤ `READ_MODEL_PENDING_RECHECKS` times).
 *
 * `search.buildDevelopmentReadModels` (a development's text, place, access or deletion; debounced): rebuilds the
 * development's units.
 *
 * `search.buildAgencyReadModels` (the agency's content locales changed; debounced): rebuilds all its documents and
 * drops those of removed locales.
 *
 * Every rebuild that changed documents queues their index push in its transaction and then asks for
 * `search.syncIndex` (S5-03; throttled: at most one waiting run, ≤ `INDEX_SYNC_THROTTLE_MS` away).
 *
 * `search.syncIndex` (after rebuilds, and schedule: every minute — the safety net after the engine was down):
 * pushes queued targets to the index. Global (batches across agencies), no group.
 *
 * `search.checkIndexDrift` (schedule: every 24 h): count and sample check of the index against read models;
 * queues mismatched samples and starts `search.repairIndex` on drift.
 *
 * `search.repairIndex` (after drift): queues every target whose index document is missing, other or orphaned.
 */
export const searchJobs = {
  buildReadModel: defineJob({
    name: 'search.buildReadModel',
    pool: 'indexing',
    payload: z.object({
      kind: ReadModelKind,
      id: z.uuid(),
      agencyId: z.uuid(),
      recheck: z.number().int().min(0).max(READ_MODEL_PENDING_RECHECKS).default(0),
    }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const result = await withSystem('search.buildReadModel', (tx) => rebuildReadModels(tx, p.kind, [p.id]));
      if (result.written + result.deleted > 0) await requestIndexSync();
      if (result.pendingMedia.length > 0 && p.recheck < READ_MODEL_PENDING_RECHECKS) {
        await enqueueReadModel(p.kind, p.id, p.agencyId, { recheck: p.recheck + 1, debounceMs: PENDING_RECHECK_MS });
      }
      log.debug({ kind: p.kind, id: p.id, ...result }, 'read model built');
      return { built: result.built, written: result.written, deleted: result.deleted };
    },
  }),

  buildDevelopmentReadModels: defineJob({
    name: 'search.buildDevelopmentReadModels',
    pool: 'indexing',
    payload: z.object({ developmentId: z.uuid(), agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 300_000,
    async run(p, { log }) {
      const result = await rebuildDevelopmentReadModels(p.developmentId);
      if (result.written + result.deleted > 0) await requestIndexSync();
      log.info({ developmentId: p.developmentId, ...result, pendingMedia: undefined }, 'development read models built');
      return { built: result.built, written: result.written, deleted: result.deleted };
    },
  }),

  buildAgencyReadModels: defineJob({
    name: 'search.buildAgencyReadModels',
    pool: 'indexing',
    payload: z.object({ agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 1_800_000,
    async run(p, { log, progress }) {
      const result = await rebuildAllReadModels({
        agencyId: p.agencyId,
        reason: 'search.buildAgencyReadModels',
        onProgress: (r) => void progress({ kind: r.kind, done: r.done }),
      });
      await requestIndexSync();
      log.info({ agencyId: p.agencyId, result }, 'agency read models built');
      return { listings: result.LISTING.built, units: result.UNIT.built };
    },
  }),

  syncIndex: defineJob({
    name: 'search.syncIndex',
    pool: 'indexing',
    payload: z.object({}),
    every: 60_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 240_000,
    async run(_p, { log, signal }) {
      const result = await syncIndex({ signal });
      if (result.more) await requestIndexSync();
      const summary = { ...result, rejected: result.rejected.length };
      // A document the engine refuses is a bug in the index builder or the engine settings: say which.
      if (result.rejected.length > 0)
        log.error({ ...summary, refused: result.rejected.slice(0, 20) }, 'search index refused documents');
      else if (result.done > 0) log.debug(summary, 'search index synced');
      return summary;
    },
  }),

  checkIndexDrift: defineJob({
    name: 'search.checkIndexDrift',
    pool: 'indexing',
    payload: z.object({}),
    every: 24 * 3_600_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 600_000,
    async run(_p, { log }) {
      const report = await checkIndexDrift();
      const summary = { ...report, mismatched: report.mismatched.length };
      if (report.drift) {
        log.warn(summary, 'search index drift: repairing');
        if (report.mismatched.length > 0) await requestIndexSync();
        await searchJobs.repairIndex.enqueue({}, { throttleMs: 1_000, debounceKey: 'repair' });
      } else {
        log.info(summary, 'search index in sync');
      }
      return summary;
    },
  }),

  repairIndex: defineJob({
    name: 'search.repairIndex',
    pool: 'indexing',
    payload: z.object({}),
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 3_600_000,
    async run(_p, { log, progress }) {
      const result = await repairIndex({
        onPage: async (r) => {
          await progress(r);
          // Push as the read-model walk goes (throttled), so the queue never grows to the whole index first. Not
          // during the index walk: removing documents would shift its pages under it.
          if (r.documents === 0 && r.stale > 0) await requestIndexSync();
        },
      });
      await requestIndexSync();
      log.info({ ...result }, 'search index repair walk done');
      return result;
    },
  }),
};

/** Asks for an index push soon (throttled). Network I/O (the queue): never inside a transaction. */
export async function requestIndexSync(): Promise<void> {
  await searchJobs.syncIndex.enqueue({}, { throttleMs: INDEX_SYNC_THROTTLE_MS, debounceKey: 'sync' });
}

/** Queues a (debounced) rebuild of one target. Network I/O (the queue): never inside a transaction. */
export async function enqueueReadModel(
  kind: 'LISTING' | 'UNIT',
  id: string,
  agencyId: string,
  options: { recheck?: number; debounceMs?: number } = {},
): Promise<void> {
  await searchJobs.buildReadModel.enqueue(
    { kind, id, agencyId, recheck: options.recheck ?? 0 },
    // A recheck has its own key: it must never replace (and delay) the rebuild an edit queued.
    {
      debounceMs: options.debounceMs ?? READ_MODEL_DEBOUNCE_MS,
      debounceKey: options.recheck ? `${id}.recheck` : id,
    },
  );
}
