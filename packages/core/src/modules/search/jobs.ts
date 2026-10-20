import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { checkIndexDrift, repairIndex, syncIndex } from './indexer';
import {
  drainReadModelQueue,
  overdueReadModelAgencies,
  queueAgencyIndexPushes,
  queueAgencyReadModelChanges,
  queueReadModelChanges,
  rebuildAllReadModels,
  rebuildDevelopmentReadModels,
} from './service';

/** Bursts of changes to one target (autosave, a batch of photos) collapse into one rebuild this long after the last. */
export const READ_MODEL_DEBOUNCE_MS = 2_000;
/** Images still processing: look again this long later, at most this many times (processing is not an event). */
const PENDING_RECHECK_MS = 60_000;
export const READ_MODEL_PENDING_RECHECKS = 10;
/** A read-model change reaches the index this long after it was written (at most; a throttle, not a debounce). */
export const INDEX_SYNC_THROTTLE_MS = 500;
/** A rebuild run's time box: it stops claiming then (what is left stays queued) and its rows' lease outlasts it. */
const READ_MODEL_RUN_BUDGET_MS = 50_000;
const READ_MODEL_LEASE_MS = 120_000;
/** Targets due this long ago and not claimed: their run was lost (Redis down when queued); the sweep asks again. */
const READ_MODEL_OVERDUE_MS = 30_000;

/**
 * search worker jobs (PATTERNS §12), pool `indexing`. Idempotent (a rebuild reads current state and never moves a
 * read model backwards), per-tenant fair share (`meta.agencyId`).
 *
 * `search.buildReadModels` (S5-F4; listing, media and unit events queue their target in `read_model_queue`, debounced
 * per target, and ask for their agency's run): rebuilds the agency's due targets `READ_MODEL_BATCH` per transaction,
 * dropping the documents of targets that have none any more. Targets whose images are still processing are queued
 * again a minute later (≤ `READ_MODEL_PENDING_RECHECKS` times).
 *
 * `search.sweepReadModelQueue` (every minute): asks again for the runs of agencies whose targets are overdue.
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
  buildReadModels: defineJob({
    name: 'search.buildReadModels',
    pool: 'indexing',
    payload: z.object({ agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: READ_MODEL_LEASE_MS,
    async run(p, { log, signal }) {
      const result = await drainReadModelQueue(p.agencyId, {
        recheckMs: PENDING_RECHECK_MS,
        maxRechecks: READ_MODEL_PENDING_RECHECKS,
        leaseMs: READ_MODEL_LEASE_MS,
        budgetMs: READ_MODEL_RUN_BUDGET_MS,
        waitMs: READ_MODEL_DEBOUNCE_MS,
        signal,
        // Each batch's documents reach the index while the run goes on (a long burst must not hold them back).
        onBatch: async (r) => {
          if (r.written + r.deleted > 0) await requestIndexSync();
        },
      });
      // Targets due later (a recheck, a burst still settling): one run then. A run already waiting for that keeps
      // its time; the sweep catches anything a lost job left behind.
      if (result.nextDueMs !== null) await requestReadModelBuild(p.agencyId, Math.max(result.nextDueMs, 0), 'later');
      log.debug({ agencyId: p.agencyId, ...result }, 'read models built');
      return result;
    },
  }),

  sweepReadModelQueue: defineJob({
    name: 'search.sweepReadModelQueue',
    pool: 'indexing',
    payload: z.object({}),
    every: 60_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(_p, { log }) {
      const agencies = await overdueReadModelAgencies(READ_MODEL_OVERDUE_MS, 1_000);
      for (const agencyId of agencies) await requestReadModelBuild(agencyId);
      if (agencies.length > 0)
        log.warn({ agencies: agencies.length }, 'read-model rebuilds overdue: jobs queued again');
      return { agencies: agencies.length };
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

/**
 * Queues a rebuild of these targets (debounced per target) and asks for their agencies' rebuild run. Called by the
 * search subscriptions. Network I/O (the queue): never inside a transaction.
 */
export async function queueReadModel(kind: 'LISTING' | 'UNIT', id: string, agencyId: string): Promise<void> {
  await queueReadModels(kind, [id], agencyId);
}

/**
 * `queueReadModel` for many targets of one agency (S6-02: an import batch's listings): one queue statement and one
 * throttled build request, whatever the count.
 */
export async function queueReadModels(
  kind: 'LISTING' | 'UNIT',
  ids: readonly string[],
  agencyId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await queueReadModelChanges(
    ids.map((targetId) => ({ kind, targetId, agencyId })),
    READ_MODEL_DEBOUNCE_MS,
  );
  await requestReadModelBuild(agencyId);
}

/**
 * Queues a rebuild of every read-model target of an agency whose status changed (S6-F1: a suspended or unlisted owner's
 * documents stop being public; a verified one's become public) — or, `preferredOnly`, of its PREFERRED listings when
 * its preferred list changed (S6-F2) — and asks for its rebuild run. Called by the search
 * subscriptions. Network I/O (the queue): never inside a transaction.
 */
export async function queueAgencyReadModels(
  agencyId: string,
  options: { preferredOnly?: boolean } = {},
): Promise<number> {
  const queued = await queueAgencyReadModelChanges(agencyId, READ_MODEL_DEBOUNCE_MS, options);
  if (queued > 0) await requestReadModelBuild(agencyId);
  return queued;
}

/**
 * Asks for one agency's rebuild run `delayMs` from now (throttled per agency and key: changes until then join the
 * run). `later` (a run for targets due later) is keyed apart, so it never holds back the run a change asks for.
 */
export async function requestReadModelBuild(
  agencyId: string,
  delayMs: number = READ_MODEL_DEBOUNCE_MS,
  key: 'now' | 'later' = 'now',
): Promise<void> {
  await searchJobs.buildReadModels.enqueue({ agencyId }, { throttleMs: Math.max(delayMs, 100), debounceKey: key });
}

/**
 * Re-pushes every index document of an agency whose identity may have changed (S7-F5: its name, contacts or website
 * are removed from its documents' indexed text) and asks for an index push. Called by the search subscriptions.
 * Network I/O (the queue): never inside a transaction.
 */
export async function queueAgencyIndexSync(agencyId: string): Promise<number> {
  const queued = await queueAgencyIndexPushes(agencyId);
  if (queued > 0) await requestIndexSync();
  return queued;
}
