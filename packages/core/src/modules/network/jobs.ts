import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { closeExpiredPosts, matchBuyerRequest, notifySubscribers } from './matching';

/**
 * network worker jobs (PATTERNS §12). Idempotent, batched, per-tenant fair share (group = the posting agency, two at a
 * time: one agency's burst of posts does not hold the pool).
 *
 * - `network.matchBuyerRequest` (pool `matching`, one per published `BUYER_REQUEST`, job ID = the post):
 *   `NETWORK_MATCH` once to each other agency with matching listings, over the search engine; then queues the post's
 *   `network.notifySubscribers` (also when it fails: subscribers are not held back by the engine), so a member told of
 *   a match is not told of the post again. Idempotent (`sourceKey` = the post).
 * - `network.notifySubscribers` (pool `matching`, one per post, job ID = the post): `NETWORK_POST` to the members of
 *   other agencies whose subscriptions match the post. Idempotent (`sourceKey` = the post).
 * - `network.closeExpiredPosts` (pool `maintenance`, every 15 minutes): OPEN posts past their expiry closed, batches
 *   of 500. Idempotent.
 */
const payload = z.object({ postId: z.uuid(), agencyId: z.uuid() });

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
