import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { closeExpiredPosts, closePostThreads, matchBuyerRequest, notifySubscribers } from './matching';

/**
 * network worker jobs (PATTERNS §12). Idempotent, batched, per-tenant fair share (group = the posting agency, two at a
 * time: one agency's burst of posts does not hold the pool).
 *
 * - `network.matchBuyerRequest` (pool `matching`, one per published `BUYER_REQUEST`, job ID = the post; at most
 *   `MATCH_GLOBAL_CONCURRENCY` running pool-wide, S12-F5):
 *   `NETWORK_MATCH` once to each other agency with matching listings, over the search engine; then queues the post's
 *   `network.notifySubscribers` (also when it fails: subscribers are not held back by the engine), so a member told of
 *   a match is not told of the post again. Idempotent (`sourceKey` = the post).
 * - `network.notifySubscribers` (pool `matching`, one per post, job ID = the post): `NETWORK_POST` to the members of
 *   other agencies whose subscriptions match the post. Idempotent (`sourceKey` = the post).
 * - `network.closeExpiredPosts` (pool `maintenance`, every 15 minutes): OPEN posts past their expiry closed, batches
 *   of 500. Idempotent.
 * - `network.closePostThreads` (pool `maintenance`, one per `network.post.closed`, job ID = the post): the post's reply
 *   threads become read-only, both agencies' copies (`closePostThreads`, S12-F12); runs once more 60 s later (job ID
 *   `…:recheck`) for a reply thread committed concurrently with the close. Idempotent.
 */
const payload = z.object({ postId: z.uuid(), agencyId: z.uuid() });

/**
 * S12-F5: buyer-request matching jobs running at once across the pool's processes. Each runs its engine rounds back to
 * back; four keep feed-api search p95 < 150 ms under 50 concurrent requests (`tests/perf/network-match-contention`).
 */
export const MATCH_GLOBAL_CONCURRENCY = 4;

/** The close-threads job's second run (a reply thread committed concurrently with the close). */
const RECHECK_MS = 60_000;

export const networkJobs = {
  notifySubscribers: defineJob({
    name: 'network.notifySubscribers',
    pool: 'matching',
    payload,
    jobId: (p) => `network.subscribers:${p.postId}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 2,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 5 * 60_000,
    async run(p) {
      return notifySubscribers(p.postId);
    },
  }),

  matchBuyerRequest: defineJob({
    name: 'network.matchBuyerRequest',
    pool: 'matching',
    payload,
    jobId: (p) => `network.match:${p.postId}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 2,
    // S12-F5: its facet rounds share the engine with website search (feed-api): a burst of buyer requests waits
    globalConcurrency: MATCH_GLOBAL_CONCURRENCY,
    attempts: 5,
    // the engine may be briefly away: retry later rather than at once
    backoff: { type: 'exponential', delay: 15_000 },
    timeoutMs: 5 * 60_000,
    async run(p) {
      try {
        return await matchBuyerRequest(p.postId);
      } finally {
        // job ID = the post: queued once, whichever attempt gets here first
        await networkJobs.notifySubscribers.enqueue(p);
      }
    },
  }),

  closePostThreads: defineJob({
    name: 'network.closePostThreads',
    pool: 'maintenance',
    payload: payload.extend({ recheck: z.boolean().optional() }),
    jobId: (p) => `network.closeThreads:${p.postId}${p.recheck ? ':recheck' : ''}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 5 * 60_000,
    async run(p) {
      const result = await closePostThreads(p);
      // once more a minute later: a reply thread opened in a transaction concurrent with the close (it read the post
      // as OPEN) commits after this run (S12-F12 review)
      if (!p.recheck) await networkJobs.closePostThreads.enqueue({ ...p, recheck: true }, { delayMs: RECHECK_MS });
      return result;
    },
  }),

  closeExpiredPosts: defineJob({
    name: 'network.closeExpiredPosts',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 15 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run() {
      return closeExpiredPosts();
    },
  }),
};
