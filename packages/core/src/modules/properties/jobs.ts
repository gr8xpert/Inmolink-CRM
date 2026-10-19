import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import { withMemberCtx } from '../../member';
import * as developments from '../developments';
import { runBulkChunk } from './bulk';
import { sweepFreshnessBatch } from './freshness';
import * as repo from './repo';

const BULK_ATTEMPTS = 5;
const BULK_TIMEOUT_MS = 30 * 60_000;
/**
 * A running bulk action that has not moved for this long is given up (`properties.failStaleBulkActions`): a chunk
 * takes about a second, so it means the job is lost (worker gone, timed out on its last attempt). Until then the
 * member's one-at-a-time slot stays taken.
 */
export const BULK_STALE_MS = 2 * 3_600_000;
/**
 * A queued action that never started is given up only after this long (S4-F3): it waits in the `imports` pool
 * behind feed imports (S6), one action per agency at a time, so hours in the queue are normal — only a job lost
 * before it ever ran stays QUEUED for a day.
 */
export const BULK_QUEUED_STALE_MS = 24 * 3_600_000;
/** Freshness sweep: rows per transaction (each kind), and at most this many transactions per run. */
const FRESHNESS_BATCH = 500;
const FRESHNESS_MAX_BATCHES = 40;
/** Override removal: targets per statement (a development's units). */
const OVERRIDE_TARGETS_PER_DELETE = 1_000;

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
 * `properties.failStaleBulkActions` (every 10 minutes, pool `maintenance`): marks FAILED (`STALLED`) the running
 * actions that have not moved for `BULK_STALE_MS`, and the queued ones not started for `BULK_QUEUED_STALE_MS` — a
 * job lost to a crash or a timeout never marks its own record.
 *
 * `properties.sweepFreshness` (S3-08; every hour, pool `maintenance`, all agencies via `withSystem`): hides from the
 * network the active listings unconfirmed for 120 days and prompts (`properties.listing.confirmationDue`) those
 * unconfirmed for 90, `FRESHNESS_BATCH` of each per transaction with their events, until a batch comes back short
 * (≤ 20,000 of each per run; the next run continues). Idempotent: hidden or prompted rows are not selected again.
 *
 * `properties.removeOverrides` (S5-F2; one per `properties.listing.purged`, `developments.unit.deleted` or
 * `developments.development.deleted` event, job ID = the event's id, pool `maintenance`, all agencies via
 * `withSystem`): removes every agency's `listing_overrides` of the target — of a development, of its units too (a
 * soft-deleted development keeps its units until its purge, and nothing restores it). Idempotent: a second run
 * finds nothing. S6-F1: inside its transaction it first checks that the target is gone (no listing or unit row; no
 * development row, or a soft-deleted one of the event's agency) — else it removes nothing. A purged listing or deleted
 * unit has no row left to name its owner: removing every agency's overrides of a target that no longer exists is
 * harmless whoever's event asked.
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
      const now = clock.now().getTime();
      const failed = await withSystem('properties.failStaleBulkActions', (tx) =>
        repo.failStaleBulks(tx, {
          runningBefore: new Date(now - BULK_STALE_MS),
          queuedBefore: new Date(now - BULK_QUEUED_STALE_MS),
        }),
      );
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

  removeOverrides: defineJob({
    name: 'properties.removeOverrides',
    pool: 'maintenance',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      targetKind: z.enum(['LISTING', 'UNIT', 'DEVELOPMENT']),
      targetId: z.uuid(),
    }),
    jobId: (p) => `properties.removeOverrides:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const removed = await withSystem('properties.removeOverrides', async (tx) => {
        // S6-F1: only a target that is gone — and, while its row remains (a soft-deleted development), the event's
        // agency's. A live target, or another agency's, keeps every agency's overrides.
        const gone =
          p.targetKind === 'LISTING'
            ? await repo.isPurged(tx, p.targetId)
            : await developments.isRemovedTarget(tx, p.targetKind, p.targetId, p.agencyId);
        if (!gone) return null;
        let n = await repo.deleteOverridesOf(tx, p.targetKind, [p.targetId]);
        if (p.targetKind === 'DEVELOPMENT') {
          const units = await developments.unitIdsForDevelopment(tx, p.targetId);
          for (let i = 0; i < units.length; i += OVERRIDE_TARGETS_PER_DELETE) {
            n += await repo.deleteOverridesOf(tx, 'UNIT', units.slice(i, i + OVERRIDE_TARGETS_PER_DELETE));
          }
        }
        return n;
      });
      if (removed === null) {
        log.warn(
          { targetKind: p.targetKind, eventId: p.eventId },
          'overrides kept: the target is live or not the agency’s',
        );
        return { removed: 0, kept: true };
      }
      if (removed > 0) log.info({ removed, targetKind: p.targetKind }, 'overrides of a removed target deleted');
      return { removed, kept: false };
    },
  }),
};
