import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * network events (PATTERNS §8), emitted with `emit(ctx.tx, …)` in the same transaction. IDs only — never a post's text.
 *
 * - `network.post.published` — an agency's new post. Subscribers: `network.notifySubscribers` (members of other
 *   agencies whose subscription matches it: `NETWORK_POST`) and, for a `BUYER_REQUEST`, `network.matchBuyerRequest`
 *   (agencies whose listings match it: `NETWORK_MATCH`, once per agency with its listings).
 * - `network.post.closed` (S12-F12) — a post closed by its agency or the expiry sweep (`agencyId`: the poster's; a
 *   closed post is never reopened). Subscriber: `network.closePostThreads` (its reply threads become read-only).
 */
export const networkEvents = {
  postPublished: defineEvent(
    'network.post.published',
    1,
    z.object({
      postId: z.uuid(),
      kind: z.enum(['BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT']),
    }),
  ),
  postClosed: defineEvent('network.post.closed', 1, z.object({ postId: z.uuid(), agencyId: z.uuid() })),
};
