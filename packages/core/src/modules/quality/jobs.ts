import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { drainQualityQueue, overdueQualityAgencies, queueQualityRecomputes } from './service';

/** Bursts of changes to one listing (autosave, a batch of photos) collapse into one recompute this long after the last. */
export const QUALITY_DEBOUNCE_MS = 2_000;
/** Photos still processing: look again this long later, at most this many times (their size is not an event). */
const PENDING_RECHECK_MS = 60_000;
export const QUALITY_PENDING_RECHECKS = 10;
/** A recompute run's time box: it stops claiming then (what is left stays queued) and its rows' lease outlasts it. */
const QUALITY_RUN_BUDGET_MS = 50_000;
const QUALITY_LEASE_MS = 120_000;
/** Listings due this long ago and not claimed: their run was lost (Redis down when queued); the sweep asks again. */
const QUALITY_OVERDUE_MS = 30_000;

/**
 * quality worker jobs (PATTERNS §12), pool `indexing`. Idempotent (a recompute reads current state), per-tenant fair
 * share (`group`: the agency).
 *
 * `quality.recomputeListings` (S6-F3, the S5-F4 queue shape; listing and media events queue the listing in
 * `quality_queue`, debounced per listing, and ask for their agency's run): claims the agency's due listings
 * `QUALITY_BATCH` at a time, scores them in the agency's tenant transaction (RLS on; about six statements per batch,
 * however many listings) and stores the scores that changed. While photos are still processing their resolution is
 * not known yet, so those listings are queued again a minute later (≤ `QUALITY_PENDING_RECHECKS` times). An import
 * that emits one event per row costs one queue row per listing, not one job.
 *
 * `quality.sweepQueue` (every minute): asks again for the runs of agencies whose listings are overdue.
 *
 * `quality.recomputeListing` (until S6-F3: one job per listing): kept so jobs queued before the deploy still land;
 * it queues its listing like an event does. Remove once no such job is left (a release after S6-F3).
 */
export const qualityJobs = {
  recomputeListings: defineJob({
    name: 'quality.recomputeListings',
    pool: 'indexing',
    payload: z.object({ agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: QUALITY_LEASE_MS,
    async run(p, { log, signal }) {
      const result = await drainQualityQueue(p.agencyId, {
        recheckMs: PENDING_RECHECK_MS,
        maxRechecks: QUALITY_PENDING_RECHECKS,
        leaseMs: QUALITY_LEASE_MS,
        budgetMs: QUALITY_RUN_BUDGET_MS,
        waitMs: QUALITY_DEBOUNCE_MS,
        signal,
      });
      // Listings due later (a recheck, a burst still settling): one run then; the sweep catches lost ones.
      if (result.nextDueMs !== null) await requestQualityRun(p.agencyId, Math.max(result.nextDueMs, 0), 'later');
      if (result.changed > 0) log.debug({ agencyId: p.agencyId, ...result }, 'listing quality stored');
      return result;
    },
  }),

  sweepQueue: defineJob({
    name: 'quality.sweepQueue',
    pool: 'indexing',
    payload: z.object({}),
    every: 60_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(_p, { log }) {
      const agencies = await overdueQualityAgencies(QUALITY_OVERDUE_MS, 1_000);
      for (const agencyId of agencies) await requestQualityRun(agencyId);
      if (agencies.length > 0) log.warn({ agencies: agencies.length }, 'quality recomputes overdue: jobs queued again');
      return { agencies: agencies.length };
    },
  }),

  recomputeListing: defineJob({
    name: 'quality.recomputeListing',
    pool: 'indexing',
    payload: z.object({ listingId: z.uuid(), agencyId: z.uuid(), recheck: z.number().int().min(0).optional() }),
    group: (p) => p.agencyId,
    attempts: 5,
    timeoutMs: 60_000,
    async run(p) {
      await enqueueRecompute(p.listingId, p.agencyId);
      return { queued: true };
    },
  }),
};

/**
 * Queues a (debounced) recompute of these listings' scores and asks for their agencies' runs. Network I/O (the
 * queue): never inside a transaction.
 */
export async function enqueueRecomputes(changes: readonly { listingId: string; agencyId: string }[]): Promise<void> {
  if (changes.length === 0) return;
  await queueQualityRecomputes(changes, QUALITY_DEBOUNCE_MS);
  for (const agencyId of new Set(changes.map((c) => c.agencyId))) await requestQualityRun(agencyId);
}

/** Queues a (debounced) recompute of one listing's score and asks for its agency's run. */
export function enqueueRecompute(listingId: string, agencyId: string): Promise<void> {
  return enqueueRecomputes([{ listingId, agencyId }]);
}

/**
 * Asks for one agency's recompute run `delayMs` from now (throttled per agency and key: changes until then join the
 * run). `later` (a run for listings due later) is keyed apart, so it never holds back the run a change asks for.
 */
export async function requestQualityRun(
  agencyId: string,
  delayMs: number = QUALITY_DEBOUNCE_MS,
  key: 'now' | 'later' = 'now',
): Promise<void> {
  await qualityJobs.recomputeListings.enqueue({ agencyId }, { throttleMs: Math.max(delayMs, 100), debounceKey: key });
}
