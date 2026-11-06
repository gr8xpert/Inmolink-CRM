import { withSystem } from '@inmolink/db';
import { ai } from '@inmolink/platform/ai';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as agencies from '../agencies';
import { DOC_OWNERS_REFRESH_MS, noteDocOwner, refreshDocOwners } from './doc-owners';
import { embeddingBackfillPage, embedListings } from './embeddings';
import { PUBLIC_DOCS_EVENT_TARGETS } from './events';
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
import { prunePublicChanges } from './website-feed';

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
 * `search.prunePublicChanges` (schedule: every hour, S7-03): drops website change-log rows past retention.
 *
 * `search.refreshDocOwners` (schedule: every minute, S16-F1): the owners of PUBLIC search documents, stored on
 * redis-cache for the portal (`doc-owners.ts`); skipped when a scan ran within the shared claim window. The read-model
 * builds mark the set stale when they write a PUBLIC document of an owner it lacks (`noteDocOwner`).
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
    async run(p, { log, signal, attempt }) {
      // S16 review: a retry may follow a failed mark after a batch was written (nothing left to drain): mark first
      if (attempt > 1) await noteDocOwner(p.agencyId);
      const result = await drainReadModelQueue(p.agencyId, {
        recheckMs: PENDING_RECHECK_MS,
        maxRechecks: READ_MODEL_PENDING_RECHECKS,
        leaseMs: READ_MODEL_LEASE_MS,
        budgetMs: READ_MODEL_RUN_BUDGET_MS,
        waitMs: READ_MODEL_DEBOUNCE_MS,
        signal,
        // Each batch's documents reach the index while the run goes on (a long burst must not hold them back).
        onBatch: async (r) => {
          // S16-F1: a new PUBLIC owner marks the portal's owner set stale before its documents reach the index.
          if (r.written > 0) await noteDocOwner(p.agencyId);
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
    async run(p, { log, attempt }) {
      const result = await rebuildDevelopmentReadModels(p.developmentId);
      // S16 review: on a retry the documents may be written already (nothing changes): mark anyway
      if (result.written > 0 || attempt > 1) await noteDocOwner(p.agencyId);
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
      await noteDocOwner(p.agencyId);
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

  prunePublicChanges: defineJob({
    name: 'search.prunePublicChanges',
    pool: 'indexing',
    payload: z.object({}),
    every: 3_600_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 300_000,
    async run(_p, { log }) {
      const deleted = await prunePublicChanges(clock.now());
      if (deleted > 0) log.info({ deleted }, 'website change log pruned');
      return { deleted };
    },
  }),

  refreshDocOwners: defineJob({
    name: 'search.refreshDocOwners',
    pool: 'indexing',
    payload: z.object({}),
    every: DOC_OWNERS_REFRESH_MS,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(_p, { log }) {
      const result = await refreshDocOwners();
      log.debug(result, 'search document owners refreshed');
      return result;
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

/** R2-01a: the embedding jobs' fair-share group, apart from the agency's interactive `ai` jobs (as `wl:<agency>`). */
export const embeddingGroup = (agencyId: string): string => `emb:${agencyId}`;
/** Once a day: listings an event missed (embeddings were off, over budget, an outage) get their vector. */
export const EMBEDDINGS_SWEEP_EVERY_MS = 24 * 3_600_000;
const SWEEP_AGENCY_PAGE = 500;
/** Job ids of a backfill page: run, agency and cursor (resumable; a re-run of the same page collapses). */
export const embeddingBackfillKey = (p: { run: string; agencyId: string; after: string | null }): string =>
  `emb.${p.run}.${p.agencyId}.${p.after ?? 'start'}`;

/**
 * Listing embedding jobs (R2-01a, `embeddings.ts`), pool `ai` (model calls) and `maintenance` (the sweep):
 *
 * - `search.embedListings` (`search.listings.changed`; job id = the event's id, so a redelivered event is one job):
 *   embeds that event's listings whose text changed, drops the vectors of those without a read model. Degraded
 *   (budget, outage): logged, left to the sweep.
 * - `search.embeddingsSweep` (schedule: every `EMBEDDINGS_SWEEP_EVERY_MS`, job ids per run day): queues one backfill
 *   walk per agency (`SWEEP_AGENCY_PAGE` agencies a query). Nothing while embeddings are off.
 * - `search.embeddingsBackfill` (one at a time per agency, group `emb:<agency>`): one window of listings (stale ones embedded, orphan
 *   vectors dropped), then queues the next page; a degraded page ends the agency's walk until the next sweep.
 */
export const embeddingJobs = {
  embedListings: defineJob({
    name: 'search.embedListings',
    pool: 'ai',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      listingIds: z.array(z.uuid()).min(1).max(PUBLIC_DOCS_EVENT_TARGETS),
    }),
    jobId: (p) => `emb.${p.eventId}`,
    group: (p) => embeddingGroup(p.agencyId),
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 5 * 60_000,
    async run(p, { log, jobId }) {
      const result = await embedListings({ agencyId: p.agencyId, listingIds: p.listingIds }, { requestId: jobId });
      if (result.degraded > 0) log.warn(result, 'listing embeddings degraded: left to the sweep');
      return result;
    },
  }),

  embeddingsSweep: defineJob({
    name: 'search.embeddingsSweep',
    pool: 'maintenance',
    payload: z.object({}),
    every: EMBEDDINGS_SWEEP_EVERY_MS,
    timeoutMs: 10 * 60_000,
    async run(_p, job) {
      if (ai.embeddingModel() === null) return { run: null, queued: 0 };
      const run = clock.now().toISOString().slice(0, 10);
      let after: string | null = null;
      let queued = 0;
      for (;;) {
        const ids: string[] = await withSystem('search.embeddingsSweep', (tx) =>
          agencies.agencyIdsPage(tx, after, SWEEP_AGENCY_PAGE),
        );
        if (ids.length > 0) {
          await embeddingJobs.embeddingsBackfill.enqueueMany(
            ids.map((agencyId) => ({ payload: { run, agencyId, after: null } })),
          );
        }
        queued += ids.length;
        after = ids.at(-1) ?? null;
        if (ids.length < SWEEP_AGENCY_PAGE || job.signal.aborted) break;
      }
      return { run, queued };
    },
  }),

  embeddingsBackfill: defineJob({
    name: 'search.embeddingsBackfill',
    pool: 'ai',
    payload: z.object({
      run: z.string().regex(/^[0-9A-Za-z-]{1,32}$/),
      agencyId: z.uuid(),
      after: z.uuid().nullable(),
    }),
    jobId: embeddingBackfillKey,
    group: (p) => embeddingGroup(p.agencyId),
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log }) {
      const key = embeddingBackfillKey(p);
      const result = await embeddingBackfillPage({ agencyId: p.agencyId, after: p.after }, { requestId: key });
      if (result.degraded > 0) log.warn(result, 'listing embedding backfill degraded: walk stopped');
      if (result.next) {
        await embeddingJobs.embeddingsBackfill.enqueue({ run: p.run, agencyId: p.agencyId, after: result.next });
      }
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
