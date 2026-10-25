import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { checkAccounts, notifyReconnect, revokeAccount } from './accounts';
import { generateCaptions } from './captions';
import { publishPost, sweepDuePosts } from './publish';

/**
 * social worker jobs (S12-07, PATTERNS §12). Idempotent, per-tenant fair share.
 *
 * - `social.sweepDuePosts` (pool `social`, every minute): claims the scheduled posts that came due (`publish.ts`).
 * - `social.publishPost` (pool `social`, one per `social.post.due` event, job ID = post + claim time, two per agency at
 *   once): publishes the post at Meta, once (`publish.ts`).
 * - `social.checkAccounts` (pool `social`, every 6 hours): refreshes tokens before they expire; marks the ones Meta
 *   refuses as needing reconnection (`accounts.ts`).
 * - `social.revokeAccount` (pool `social`, one per `social.account.disconnected` event): revokes the app's permissions
 *   at Meta and deletes the account (`accounts.ts`).
 * - `social.notifyReconnect` (pool `realtime`, one per `social.account.needsReconnect` event, job ID = the event's id):
 *   the admins' `SOCIAL_ACCOUNT_RECONNECT` notification.
 * - `social.generateCaptions` (pool `ai`, one per `social.captions.requested` event, job ID = the request's id): AI
 *   captions per language (`captions.ts`).
 */
export const socialJobs = {
  sweepDuePosts: defineJob({
    name: 'social.sweepDuePosts',
    pool: 'social',
    payload: z.object({}).strict(),
    every: 60_000,
    attempts: 3,
    timeoutMs: 2 * 60_000,
    async run(_p, { log }) {
      const res = await sweepDuePosts();
      if (res.claimed > 0) log.info({ claimed: res.claimed }, 'social posts claimed');
      return res;
    },
  }),

  publishPost: defineJob({
    name: 'social.publishPost',
    pool: 'social',
    payload: z.object({ postId: z.uuid(), agencyId: z.uuid(), claimedAtMs: z.number().int() }),
    jobId: (p) => `${p.postId}:${p.claimedAtMs}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 2,
    // A retried job finds its claim marked as started and fails the post as OUTCOME_UNKNOWN (never posts twice).
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 3 * 60_000,
    async run(p, { log }) {
      const res = await publishPost(p);
      log.info({ postId: p.postId, outcome: res.outcome }, 'social post published');
      return res;
    },
  }),

  checkAccounts: defineJob({
    name: 'social.checkAccounts',
    pool: 'social',
    payload: z.object({}).strict(),
    every: 6 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log }) {
      const res = await checkAccounts();
      if (res.checked > 0) log.info(res, 'social account tokens checked');
      return res;
    },
  }),

  revokeAccount: defineJob({
    name: 'social.revokeAccount',
    pool: 'social',
    payload: z.object({ agencyId: z.uuid(), accountId: z.uuid() }),
    jobId: (p) => `social.revokeAccount:${p.accountId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 60_000,
    async run(p) {
      return revokeAccount(p);
    },
  }),

  notifyReconnect: defineJob({
    name: 'social.notifyReconnect',
    pool: 'realtime',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      accountId: z.uuid(),
      occurredAt: z.iso.datetime(),
    }),
    jobId: (p) => `social.notifyReconnect:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return notifyReconnect(p);
    },
  }),

  generateCaptions: defineJob({
    name: 'social.generateCaptions',
    pool: 'ai',
    payload: z.object({
      postId: z.uuid(),
      agencyId: z.uuid(),
      requestId: z.uuid(),
      locales: z.array(z.string().max(10)).min(1).max(5),
    }),
    jobId: (p) => p.requestId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 2,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 2 * 60_000,
    async run(p) {
      return generateCaptions(p);
    },
  }),
};
