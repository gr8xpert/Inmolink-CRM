import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { digestAgencies, matchListings, pruneMatching, sendDigest } from './service';

/** The daily digest sweep spreads the agencies' digests over this long (stable per agency), not all at once. */
export const DIGEST_SPREAD_MS = 60 * 60_000;

/** A stable delay in [0, DIGEST_SPREAD_MS) per agency (its id's last hex digits). */
export const digestDelayOf = (agencyId: string): number =>
  Number.parseInt(agencyId.replace(/-/g, '').slice(-8), 16) % DIGEST_SPREAD_MS;

/**
 * matching worker jobs (PATTERNS §12, pool `matching`). Idempotent, batched, per-tenant fair share.
 *
 * - `matching.matchListings` — one per `search.listings.changed` event (job ID = the event's id; group = the listings'
 *   agency): the event's listings against the saved searches (`service.matchListings`). A retry alerts nobody twice
 *   (the alerts' unique key), however far the first run got.
 * - `matching.sendDigest` — per agency (group = the agency): its DAILY saved searches' waiting alerts as one
 *   notification per saved search; runs again while more are waiting.
 * - `matching.sweepDigests` — every 24 hours: queues each agency's digest (spread over `DIGEST_SPREAD_MS`), then prunes
 *   alerts older than 90 days and states of listings gone 180 days.
 */
export const matchingJobs = {
  matchListings: defineJob({
    name: 'matching.matchListings',
    pool: 'matching',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      listingIds: z.array(z.uuid()).min(1).max(100),
    }),
    jobId: (p) => `match:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const result = await matchListings(p);
      if (result.alerts > 0) log.info(result, 'saved search alerts raised');
      return result;
    },
  }),

  sendDigest: defineJob({
    name: 'matching.sendDigest',
    pool: 'matching',
    payload: z.object({ agencyId: z.uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    jobId: (p) => `digest:${p.agencyId}:${p.day}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 120_000,
    async run(p, { log, signal }) {
      let notified = 0;
      for (;;) {
        const r = await sendDigest(p.agencyId);
        notified += r.notified;
        if (!r.more || signal.aborted) break;
      }
      if (notified > 0) log.info({ notified }, 'saved search digest sent');
      return { notified };
    },
  }),

  sweepDigests: defineJob({
    name: 'matching.sweepDigests',
    pool: 'matching',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const day = new Date().toISOString().slice(0, 10);
      let after: string | null = null;
      let queued = 0;
      while (!signal.aborted) {
        const page = await digestAgencies(after);
        if (page.length === 0) break;
        await matchingJobs.sendDigest.enqueueMany(
          page.map((agencyId) => ({ payload: { agencyId, day }, options: { delayMs: digestDelayOf(agencyId) } })),
        );
        queued += page.length;
        after = page.at(-1) ?? null;
      }
      const pruned = await pruneMatching();
      log.info({ queued, ...pruned }, 'saved search digests queued, old alerts pruned');
      return { queued, ...pruned };
    },
  }),
};
