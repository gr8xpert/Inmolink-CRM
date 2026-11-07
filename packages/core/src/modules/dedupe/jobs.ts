/**
 * dedupe worker jobs (PATTERNS §12, pool `matching`: cross-agency similarity work beside the match engine; the daily
 * sweep's scheduler in `maintenance`). Idempotent, batched, per-tenant fair share.
 *
 * - `dedupe.rescoreListings` — one per `search.listings.changed` event (job ID = the event's id: a redelivered event
 *   adds nothing; group = the listings' agency): the event's listings' signatures refreshed, the changed ones'
 *   candidates found by blocking and scored (`service.ts`). Media changes reach it through the read-model rebuild they
 *   cause. One transaction: a retry re-runs the same idempotent upserts.
 * - `dedupe.backfill` — queued once after deploy, and after a signature or scorer version change (`{ after: null }`):
 *   one window of `BACKFILL_WINDOW` listings rescored (forced), each run queueing the next (job ID per run key and
 *   cursor: a version change is a new walk).
 * - `dedupe.sweep` — every 24 hours: starts `dedupe.sweepWindow` (job ID per day), which walks the stored signatures in
 *   windows and drops those whose listing has no read model any more (a lost event, an erased agency).
 */
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { BACKFILL_RUN, backfillWindow, RESCORE_BATCH, rescoreListings, sweepWindow } from './service';

export const DEDUPE_SWEEP_EVERY_MS = 24 * 3_600_000;
const RUN = z.string().regex(/^[0-9A-Za-z.-]{1,32}$/);

export const dedupeJobs = {
  rescoreListings: defineJob({
    name: 'dedupe.rescoreListings',
    pool: 'matching',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      listingIds: z.array(z.uuid()).min(1).max(RESCORE_BATCH),
    }),
    jobId: (p) => `dedupe:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 120_000,
    async run(p, { log }) {
      const result = await rescoreListings(p.listingIds);
      if (result.stored > 0 || result.deleted > 0) log.info(result, 'duplicate candidates rescored');
      return result;
    },
  }),

  backfill: defineJob({
    name: 'dedupe.backfill',
    pool: 'matching',
    payload: z.object({ run: RUN.default(BACKFILL_RUN), after: z.uuid().nullable() }),
    jobId: (p) => `dedupe-backfill.${p.run}.${p.after ?? 'start'}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log }) {
      const r = await backfillWindow(p.after);
      if (r.next) await dedupeJobs.backfill.enqueue({ run: p.run, after: r.next });
      else log.info({ run: p.run }, 'duplicate detection backfilled');
      return r;
    },
  }),

  sweep: defineJob({
    name: 'dedupe.sweep',
    pool: 'maintenance',
    payload: z.object({}),
    every: DEDUPE_SWEEP_EVERY_MS,
    timeoutMs: 60_000,
    async run() {
      const run = clock.now().toISOString().slice(0, 10);
      await dedupeJobs.sweepWindow.enqueue({ run, after: null });
      return { run };
    },
  }),

  sweepWindow: defineJob({
    name: 'dedupe.sweepWindow',
    pool: 'matching',
    payload: z.object({ run: RUN, after: z.uuid().nullable() }),
    jobId: (p) => `dedupe-sweep.${p.run}.${p.after ?? 'start'}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log }) {
      const r = await sweepWindow(p.after);
      if (r.next) await dedupeJobs.sweepWindow.enqueue({ run: p.run, after: r.next });
      if (r.dropped > 0) log.info({ dropped: r.dropped }, 'orphaned duplicate signatures dropped');
      return r;
    },
  }),
};
