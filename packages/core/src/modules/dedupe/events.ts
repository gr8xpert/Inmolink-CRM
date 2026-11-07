import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/** Listings per `dedupe.pairs.changed` event (one rescore batch). */
export const PAIRS_EVENT_IDS = 100;

/**
 * dedupe events (PATTERNS §8), emitted with `emit(tx, …)` in the transaction of the change. IDs only.
 *
 * - `dedupe.pairs.changed` (R2-03b, platform event): these listings' signatures or stored pairs changed, or a listing
 *   went away (the rescore's transaction). The dedupe worker reclusters around them (`dedupe.recluster`).
 * - `dedupe.cluster.changed` (R2-03b, platform event): a cluster's members, ranks (so its canonical) or flag changed,
 *   it was formed, or it was dissolved (`canonicalListingId` null) — with the listings that were or are in it. Emitted
 *   by the recluster pass in its transaction; R2-03c's canonical-only outputs and the read models react to it.
 * - `dedupe.review.decided` (R2-03b, the agency's): a member decided a review-queue pair. The worker records the
 *   decision (a "not a duplicate" is final) and reclusters the pair.
 * - `dedupe.dispute.resolved` (R2-03b, the disputing agency's, appended by staff): the worker applies an upheld
 *   dispute (the listing split from its cluster, or made its canonical).
 */
export const dedupeEvents = {
  pairsChanged: defineEvent(
    'dedupe.pairs.changed',
    1,
    z.object({ listingIds: z.array(z.uuid()).min(1).max(PAIRS_EVENT_IDS) }),
  ),
  clusterChanged: defineEvent(
    'dedupe.cluster.changed',
    1,
    z.object({
      clusterId: z.uuid(),
      canonicalListingId: z.uuid().nullable(),
      listingIds: z.array(z.uuid()).min(1).max(128),
    }),
  ),
  reviewDecided: defineEvent('dedupe.review.decided', 1, z.object({ reviewId: z.uuid() })),
  disputeResolved: defineEvent('dedupe.dispute.resolved', 1, z.object({ disputeId: z.uuid() })),
};
