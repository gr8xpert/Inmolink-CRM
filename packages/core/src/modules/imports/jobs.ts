import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as properties from '../properties';
import { maxConcurrentRuns, RUNS, runsPerProcess } from './config';
import { importsEvents } from './events';
import { recordOldestQueued } from './guard';
import { listingSink } from './load';
import { notifyConnectionPaused } from './pause-notice';
import * as repo from './repo';
import { executeRun } from './runner';
import { deleteReleasedSheet, sweepSheets } from './sheet/lifecycle';

/** Total attempts of a run job: a retryable failure (network, 5xx, timeout) re-queues the run that often. */
const RUN_ATTEMPTS = 3;
/** A run's whole budget (fetch included); the feed fetch itself stops at 20 minutes. */
const RUN_TIMEOUT_MS = 60 * 60_000;
/** Seen references older than this belong to a run that died (S6-02); deleted `SEEN_PRUNE_BATCH` per statement. */
const SEEN_RETENTION_MS = 24 * 3_600_000;
const SEEN_PRUNE_BATCH = 5_000;

/**
 * Runs `step` (one transaction each) until it does less than `batch`, the job is cancelled, `maxSteps` ran or
 * `budgetMs` passed (S7-F3). Answers the total and whether work may be left.
 */
async function drain(
  step: () => Promise<number>,
  opts: { batch: number; budgetMs: number; maxSteps?: number; signal: AbortSignal },
): Promise<{ total: number; more: boolean }> {
  const stopAt = Date.now() + opts.budgetMs;
  let total = 0;
  for (let i = 0; i < (opts.maxSteps ?? Number.POSITIVE_INFINITY); i++) {
    if (opts.signal.aborted || Date.now() >= stopAt) return { total, more: true };
    const n = await step();
    total += n;
    if (n < opts.batch) return { total, more: false };
  }
  return { total, more: true };
}

/**
 * imports worker jobs (PATTERNS §12). Idempotent, per-tenant fair share.
 *
 * `imports.runFeed` (one per `imports.run.requested` event, job ID = the run's id, pool `imports`, one run per
 * agency at a time, at most `IMPORT_RUNS_PER_PROCESS` in one process — S6 review: RSS — and at most
 * `IMPORT_MAX_CONCURRENT_RUNS` across every worker — S6-08 — so the pool's other jobs keep their slots and the database a bounded write load; fair share between agencies: an agency's job is queued at its
 * backlog depth, so one agency's many feeds interleave with everyone else's first feed, `platform/queue`): claims the run row (fencing token + lease) and executes it (`runner.ts`) through the listing loader (`load.ts`, S6-02). A second delivery
 * finds the run claimed or ended and does nothing. Retryable failures re-queue the run for the next attempt; the
 * last attempt records it FAILED. S7-F12: a resumable connector's run (Resales Online) commits a checkpoint per page
 * and, after `RUNS.SLICE_MARKS` pages, hands its slot back and queues its next slice as a new job (`resume`); a retry
 * or a slice resumes from the checkpoint with the run's counters and seen references kept.
 *
 * `imports.scheduleFeeds` (every minute, pool `imports`, all agencies via `withSystem`): fails the runs whose
 * worker is gone (lease lapsed > `RUNS.LEASE_GRACE_MS`, or queued > `RUNS.QUEUED_STALE_MS`), then queues a run
 * for every enabled connection whose `next_run_at` passed (`RUNS.SCHEDULE_BATCH` per transaction, at most
 * `RUNS.SCHEDULE_PER_AGENCY` of one agency each, batch after batch until none is due — S7-F3 — bounded per tick by
 * `RUNS.SCHEDULE_MAX_BATCHES` and `RUNS.SCHEDULE_BUDGET_MS`) and moves its
 * `next_run_at` one interval on. A connection whose previous run is still active skips that slot (the
 * per-connection mutex). Schedules live in Postgres, not in one BullMQ scheduler per connection: nothing to keep in
 * sync when a connection changes or is deleted.
 *
 * `imports.pruneRuns` (daily, pool `maintenance`, all agencies via `withSystem`): deletes finished runs older than
 * `RUNS.RETENTION_DAYS` with their item errors, ≤ `RUNS.PRUNE_BATCH` runs and ≈ `RUNS.PRUNE_ERRORS_PER_BATCH` errors per
 * transaction until none is left (S7-F3, within
 * `RUNS.PRUNE_BUDGET_MS`); then the seen feed references a run that died before its end left (S6-02, older than a day).
 *
 * `imports.deleteSheet` (one per `imports.sheet.released` event, pool `maintenance`, S7-F1): deletes the uploaded file
 * a deleted connection or a replacing upload let go, unless another connection of the agency still uses it.
 * `imports.sweepSheets` (daily, pool `maintenance`, S7-F1): deletes uploaded files idle for 30 days and files no
 * connection points to (`sheet/lifecycle.ts`).
 */
export const importsJobs = {
  runFeed: defineJob({
    name: 'imports.runFeed',
    pool: 'imports',
    // S7-F12: `resume` — a slice of a long run, queued by the slice before it (a job id of its own).
    payload: z.object({ runId: z.uuid(), agencyId: z.uuid(), resume: z.number().int().min(1).optional() }),
    jobId: (p) => (p.resume ? `${p.runId}:${p.resume}` : p.runId),
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    globalConcurrency: maxConcurrentRuns,
    perProcessConcurrency: runsPerProcess,
    attempts: RUN_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: RUN_TIMEOUT_MS,
    async run(p, job) {
      const outcome = await executeRun(
        { runId: p.runId, agencyId: p.agencyId },
        { log: job.log, signal: job.signal, lastAttempt: job.attempt >= RUN_ATTEMPTS },
        listingSink,
      );
      return outcome;
    },
  }),

  scheduleFeeds: defineJob({
    name: 'imports.scheduleFeeds',
    pool: 'imports',
    payload: z.object({}).strict(),
    every: 60_000,
    attempts: 3,
    async run(_p, { log, signal }) {
      const failed = await withSystem('imports.scheduleFeeds: fail stale runs', async (tx) => {
        const rows = await repo.failStaleRuns(tx, RUNS.LEASE_GRACE_MS, RUNS.QUEUED_STALE_MS);
        await emit(
          tx,
          rows.map((r) =>
            importsEvents.runFinished({
              runId: r.id,
              connectionId: r.connectionId,
              agencyId: r.agencyId,
              state: 'FAILED',
              errorCode: r.errorCode,
            }),
          ),
        );
        return rows.length;
      });
      if (failed > 0) log.warn({ failed }, 'stale feed runs marked FAILED');
      // S7-F3: batch after batch (each its own transaction, <= `SCHEDULE_PER_AGENCY` per agency) until none is due.
      // A batch counts the connections it claimed (each leaves the due set: its slot moves on, or a connection without
      // a schedule loses it), so one whose previous run is still active never keeps the loop going or ends it early.
      let queued = 0;
      const scheduled = await drain(
        () =>
          withSystem('imports.scheduleFeeds: queue due runs', async (tx) => {
            const due = await repo.queueDueRuns(tx, RUNS.SCHEDULE_BATCH, RUNS.SCHEDULE_PER_AGENCY, newId);
            await emit(
              tx,
              due.runs.map((r) =>
                importsEvents.runRequested({ runId: r.id, connectionId: r.connectionId, agencyId: r.agencyId }),
              ),
            );
            queued += due.runs.length;
            return due.claimed;
          }),
        {
          // a batch below `SCHEDULE_BATCH` may only mean the per-agency cap: stop on an empty one
          batch: 1,
          budgetMs: RUNS.SCHEDULE_BUDGET_MS,
          maxSteps: RUNS.SCHEDULE_MAX_BATCHES,
          signal,
        },
      );
      if (queued > 0) log.info({ queued }, 'scheduled feed runs queued');
      if (scheduled.more) log.warn({ queued }, 'feed scheduler tick bound reached; the next tick queues the rest');
      // S6-08: queue lag as a metric (alert ImportQueueWaitHigh), one index-only aggregate per tick.
      const snapshot = await withSystem('imports.scheduleFeeds: queue lag', (tx) => repo.queueSnapshot(tx));
      recordOldestQueued(snapshot.oldestQueuedSeconds);
      return { failed, queued, oldestQueuedSeconds: snapshot.oldestQueuedSeconds };
    },
  }),

  pruneRuns: defineJob({
    name: 'imports.pruneRuns',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: RUNS.PRUNE_BUDGET_MS + 5 * 60_000,
    async run(_p, { log, signal }) {
      const before = new Date(clock.now().getTime() - RUNS.RETENTION_DAYS * 24 * 3_600_000);
      // S7-F3: until nothing expired is left (one transaction per batch), within the job's budget.
      // A batch is short when its runs carry many errors, so the loop stops on an empty one.
      let errors = 0;
      let maxErrorsInBatch = 0;
      const runs = await drain(
        () =>
          withSystem('imports.pruneRuns', async (tx) => {
            const d = await repo.pruneRuns(tx, before, RUNS.PRUNE_BATCH, RUNS.PRUNE_ERRORS_PER_BATCH);
            errors += d.errors;
            maxErrorsInBatch = Math.max(maxErrorsInBatch, d.errors);
            return d.runs;
          }),
        { batch: 1, budgetMs: RUNS.PRUNE_BUDGET_MS, signal },
      );
      // S6-02: the seen feed references a run that died before its end left behind (a run lasts ≤ RUN_TIMEOUT_MS).
      // S7-F12: never those of a run still queued or running — a run resumed across slices may last days.
      const seenBefore = new Date(clock.now().getTime() - SEEN_RETENTION_MS);
      const active = await withSystem('imports.pruneRuns: active runs', (tx) => repo.activeRunIds(tx));
      const seen = await drain(
        () =>
          withSystem('imports.pruneRuns: stale seen references', (tx) =>
            properties.pruneImportSeen(tx, seenBefore, SEEN_PRUNE_BATCH, active),
          ),
        { batch: SEEN_PRUNE_BATCH, budgetMs: RUNS.PRUNE_BUDGET_MS / 5, signal },
      );
      const result = { deleted: runs.total, errors, maxErrorsInBatch, seen: seen.total, more: runs.more || seen.more };
      if (result.deleted > 0 || result.seen > 0) log.info(result, 'old feed runs pruned');
      if (result.more) log.warn(result, 'feed run prune budget spent; the next run continues');
      return result;
    },
  }),

  // S12-F2: the admins' `IMPORT_PAUSED` notification, one per `imports.connection.paused` event (pool `realtime`: a
  // live in-app notice), job ID = the event's id. Idempotent (`sourceKey` = the event's id).
  notifyConnectionPaused: defineJob({
    name: 'imports.notifyConnectionPaused',
    pool: 'realtime',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      connectionId: z.uuid(),
      occurredAt: z.iso.datetime(),
    }),
    jobId: (p) => `imports.notifyConnectionPaused:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return notifyConnectionPaused(p);
    },
  }),

  deleteSheet: defineJob({
    name: 'imports.deleteSheet',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), fileId: z.uuid() }),
    // One job per release event: a redelivered event adds nothing, a later release of the same file (shared by two
    // connections) is a new event and never deduplicated away.
    jobId: (p) => `imports.deleteSheet:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    async run(p) {
      return deleteReleasedSheet({ agencyId: p.agencyId, fileId: p.fileId });
    },
  }),

  sweepSheets: defineJob({
    name: 'imports.sweepSheets',
    pool: 'maintenance',
    payload: z.object({ maxPages: z.number().int().min(1).max(1_000).optional() }).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(p, { log, signal }) {
      const result = await sweepSheets({ signal, ...(p.maxPages ? { maxPages: p.maxPages } : {}) });
      if (result.deleted > 0) log.info(result, 'uploaded sheets deleted');
      return result;
    },
  }),
};
