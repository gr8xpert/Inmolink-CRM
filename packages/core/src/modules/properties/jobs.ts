import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import { withMemberCtx } from '../../member';
import { runBulkChunk } from './bulk';
import { sweepFreshnessBatch } from './freshness';
import * as repo from './repo';

const BULK_ATTEMPTS = 5;
const BULK_TIMEOUT_MS = 30 * 60_000;
/**
 * A waiting or running bulk action that has not moved for this long is given up (`properties.failStaleBulkActions`):
 * a chunk takes about a second, so it means the job is lost (worker gone, timed out on its last attempt). Until
 * then the member's one-at-a-time slot stays taken.
 */
export const BULK_STALE_MS = 2 * 3_600_000;
/** Freshness sweep: rows per transaction (each kind), and at most this many transactions per run. */
const FRESHNESS_BATCH = 500;
const FRESHNESS_MAX_BATCHES = 40;

/**
 * properties worker jobs (PATTERNS §12). Idempotent, batched, per-tenant fair share.
 *
 * `properties.runBulkAction` (S3-07; one per `properties.bulkAction.requested` event, job ID = the action's id):
 * runs a bulk action chunk by chunk (`bulk.ts`), each chunk in its own transaction as the member who asked —
 * role, membership and verification re-read every chunk — and reports `{ processed, total }` as job progress
 * (the dashboard polls the record, whose counters commit with each chunk). Pool `imports` (bulk listing writes),
 * one action per agency at a time (and one waiting or running per member). A member who left, or an agency
 * suspended meanwhile, stops the action (FAILED with the code); any other error retries from the last committed
 * chunk, and the last attempt marks it FAILED whatever ended it (an abort included).
 *
 * `properties.failStaleBulkActions` (every 10 minutes, pool `maintenance`): marks FAILED (`STALLED`) the actions
 * that have not moved for `BULK_STALE_MS` — a job lost to a crash or a timeout never marks its own record.
 *
 * `properties.sweepFreshness` (S3-08; every hour, pool `maintenance`, all agencies via `withSystem`): hides from the
 * network the active listings unconfirmed for 120 days and prompts (`properties.listing.confirmationDue`) those
 * unconfirmed for 90, `FRESHNESS_BATCH` of each per transaction with their events, until a batch comes back short
 * (≤ 20,000 of each per run; the next run continues). Idempotent: hidden or prompted rows are not selected again.
 */
export const propertiesJobs = {
  runBulkAction: defineJob({
    name: 'properties.runBulkAction',
    pool: 'imports',
    payload: z.object({ bulkActionId: z.uuid(), agencyId: z.uuid(), userId: z.uuid() }),
    jobId: (p) => p.bulkActionId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: BULK_ATTEMPTS,
    timeoutMs: BULK_TIMEOUT_MS,
    async run(p, job) {
      const stop = (code: string) =>
        withSystem('properties.runBulkAction', (tx) => repo.failBulk(tx, p.agencyId, p.bulkActionId, code));
      try {
        for (;;) {
          if (job.signal.aborted) throw new Error('properties.runBulkAction: aborted');
          const step = await withMemberCtx({ userId: p.userId, agencyId: p.agencyId, requestId: job.jobId }, (ctx) =>
            runBulkChunk(ctx, p.bulkActionId),
          );
          await job.progress({ processed: step.processed, total: step.total });
          if (step.done) {
            job.log.info({ bulkActionId: p.bulkActionId, total: step.total }, 'bulk action done');
            return;
          }
        }
      } catch (err) {
        if (isAppError(err) && err.code === 'FORBIDDEN') {
          await stop('FORBIDDEN');
          throw new UnrecoverableError('the member can no longer act for the agency');
        }
        if (job.attempt >= BULK_ATTEMPTS) await stop('INTERNAL');
        throw err;
      }
    },
  }),

  failStaleBulkActions: defineJob({
    name: 'properties.failStaleBulkActions',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 10 * 60_000,
    attempts: 3,
    async run(_p, { log }) {
      const before = new Date(clock.now().getTime() - BULK_STALE_MS);
      const failed = await withSystem('properties.failStaleBulkActions', (tx) => repo.failStaleBulks(tx, before));
      if (failed > 0) log.warn({ failed }, 'stale bulk actions marked FAILED');
      return { failed };
    },
  }),

  sweepFreshness: defineJob({
    name: 'properties.sweepFreshness',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      let hidden = 0;
      let prompted = 0;
      for (let i = 0; i < FRESHNESS_MAX_BATCHES && !signal.aborted; i++) {
        const step = await withSystem('properties.sweepFreshness', (tx) =>
          sweepFreshnessBatch(tx, clock.now(), FRESHNESS_BATCH),
        );
        hidden += step.hidden;
        prompted += step.prompted;
        if (step.hidden < FRESHNESS_BATCH && step.prompted < FRESHNESS_BATCH) break;
      }
      if (hidden + prompted > 0) log.info({ hidden, prompted }, 'listing freshness swept');
      return { hidden, prompted };
    },
  }),
};
