import { LISTING_STUDIO_BULK_MAX, ListingStudioTone } from '@inmolink/contracts';
import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * ai-features events (PATTERNS §8): emitted with `emit(ctx.tx, …)` in the same transaction. IDs and small
 * parameters only.
 */
export const aiFeaturesEvents = {
  /**
   * S12-02: a member asked the Listing Studio for AI drafts (`SINGLE`: one listing, `BULK`: the batch API). The
   * worker turns it into one job (job ID = `requestId`), run as that member (`meta.agencyId`).
   */
  listingStudioRequested: defineEvent(
    'aiFeatures.listingStudio.requested',
    1,
    z.object({
      requestId: z.uuid(),
      userId: z.uuid(),
      listingIds: z.array(z.uuid()).min(1).max(LISTING_STUDIO_BULK_MAX),
      tone: ListingStudioTone,
      locales: z.array(z.string()).min(1).max(20),
      replaceReviewed: z.boolean(),
      mode: z.enum(['SINGLE', 'BULK']),
    }),
  ),
};
