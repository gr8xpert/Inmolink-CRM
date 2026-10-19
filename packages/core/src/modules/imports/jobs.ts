import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { RUNS } from './config';
import { importsEvents } from './events';
import * as repo from './repo';
import { executeRun } from './runner';

/** Total attempts of a run job: a retryable failure (network, 5xx, timeout) re-queues the run that often. */
const RUN_ATTEMPTS = 3;
/** A run's whole budget (fetch included); the feed fetch itself stops at 20 minutes. */
const RUN_TIMEOUT_MS = 60 * 60_000;
/** Finished runs deleted per statement, and statements per prune run. */
const PRUNE_BATCH = 1_000;
const PRUNE_MAX_BATCHES = 50;

/**
 * imports worker jobs (PATTERNS §12). Idempotent, per-tenant fair share.
 *
 * `imports.runFeed` (one per `imports.run.requested` event, job ID = the run's id, pool `imports`, one run per
 * agency at a time): claims the run row (fencing token + lease) and executes it (`runner.ts`). A second delivery
 * finds the run claimed or ended and does nothing. Retryable failures re-queue the run for the next attempt; the
 * last attempt records it FAILED.
 *
 * `imports.scheduleFeeds` (every minute, pool `imports`, all agencies via `withSystem`): fails the runs whose
 * worker is gone (lease lapsed > `RUNS.LEASE_GRACE_MS`, or queued > `RUNS.QUEUED_STALE_MS`), then queues a run
 * for every enabled connection whose `next_run_at` passed (≤ `RUNS.SCHEDULE_BATCH` per tick) and moves its
 * `next_run_at` one interval on. A connection whose previous run is still active skips that slot (the
 * per-connection mutex). Schedules live in Postgres, not in one BullMQ scheduler per connection: nothing to keep in
 * sync when a connection changes or is deleted.
 *
 * `imports.pruneRuns` (daily, pool `maintenance`, all agencies via `withSystem`): deletes finished runs older than
 * `RUNS.RETENTION_DAYS` with their item errors, `PRUNE_BATCH` per statement.
 */
export const importsJobs = {
  runFeed: defineJob({
    name: 'imports.runFeed',
    pool: 'imports',
    payload: z.object({ runId: z.uuid(), agencyId: z.uuid() }),
    jobId: (p) => p.runId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: RUN_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: RUN_TIMEOUT_MS,
    async run(p, job) {
      const outcome = await executeRun(p, {
        log: job.log,
        signal: job.signal,
        lastAttempt: job.attempt >= RUN_ATTEMPTS,
      });
      return outcome;
    },
  }),

  scheduleFeeds: defineJob({
    name: 'imports.scheduleFeeds',
    pool: 'imports',
    payload: z.object({}).strict(),
    every: 60_000,
    attempts: 3,
    async run(_p, { log }) {
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
      const queued = await withSystem('imports.scheduleFeeds: queue due runs', async (tx) => {
        const runs = await repo.queueDueRuns(tx, RUNS.SCHEDULE_BATCH, RUNS.SCHEDULE_PER_AGENCY, newId);
        await emit(
          tx,
          runs.map((r) =>
            importsEvents.runRequested({ runId: r.id, connectionId: r.connectionId, agencyId: r.agencyId }),
          ),
        );
        return runs.length;
      });
      if (queued > 0) log.info({ queued }, 'scheduled feed runs queued');
      return { failed, queued };
    },
  }),

  pruneRuns: defineJob({
    name: 'imports.pruneRuns',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    async run(_p, { log, signal }) {
      const before = new Date(clock.now().getTime() - RUNS.RETENTION_DAYS * 24 * 3_600_000);
      let deleted = 0;
      for (let i = 0; i < PRUNE_MAX_BATCHES && !signal.aborted; i++) {
        const n = await withSystem('imports.pruneRuns', (tx) => repo.pruneRuns(tx, before, PRUNE_BATCH));
        deleted += n;
        if (n < PRUNE_BATCH) break;
      }
      if (deleted > 0) log.info({ deleted }, 'old feed runs pruned');
      return { deleted };
    },
  }),
};
