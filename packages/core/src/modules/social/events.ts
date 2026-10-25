import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * social events (S12-07, PATTERNS §8), emitted in the transaction of the change. IDs only.
 *
 * - `social.post.due` — the publish sweep claimed a scheduled post (PUBLISHING); the subscription enqueues
 *   `social.publishPost` with the post and claim time as job ID (a redelivered event adds nothing).
 * - `social.captions.requested` — a member asked for AI captions; the subscription enqueues `social.generateCaptions`
 *   (pool `ai`), job ID = the request's id.
 * - `social.account.needsReconnect` — an account's token expired or was revoked (publishing or the token check found
 *   it); the subscription enqueues `social.notifyReconnect` — a `SOCIAL_ACCOUNT_RECONNECT` notification to the admins.
 */
export const socialEvents = {
  postDue: defineEvent(
    'social.post.due',
    1,
    z.object({ postId: z.uuid(), agencyId: z.uuid(), claimedAtMs: z.number().int() }),
  ),
  captionsRequested: defineEvent(
    'social.captions.requested',
    1,
    z.object({
      postId: z.uuid(),
      agencyId: z.uuid(),
      requestId: z.uuid(),
      locales: z
        .array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/))
        .min(1)
        .max(5),
    }),
  ),
  /** S12-07 review: an admin disconnected an account; the worker deletes it with its posts and tokens. */
  accountDisconnected: defineEvent(
    'social.account.disconnected',
    1,
    z.object({ accountId: z.uuid(), agencyId: z.uuid() }),
  ),
  accountNeedsReconnect: defineEvent(
    'social.account.needsReconnect',
    1,
    z.object({ accountId: z.uuid(), agencyId: z.uuid(), reason: z.string().max(40) }),
  ),
};
