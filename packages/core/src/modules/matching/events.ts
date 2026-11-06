import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/** Profiles per `matching.clientProfiles.changed` event (keeps the payload and its job's well under 10 KB). */
export const CLIENT_PROFILE_EVENT_IDS = 100;

/**
 * matching events (PATTERNS §8). Saved-search alerts (S5-06) are delivered as notifications in the transaction that
 * writes them, and the notifications module announces those.
 *
 * - `matching.clientProfiles.changed` (R2-01b): these client profiles of one agency were created, changed or deleted
 *   (≤ `CLIENT_PROFILE_EVENT_IDS` ids). Emitted by the profile service (R2-02) in the write's transaction. The matching
 *   worker re-embeds the ones whose text changed and drops the vectors of deleted or switched-off ones. IDs only.
 * - `matching.clientProfileMatch.dismissed` (R2-02c): a member dismissed this match (R2-02d's review queue emits it in
 *   the transaction that sets `DISMISSED`). The matching worker counts the listing as one the client turned down
 *   (the learned boost). IDs only.
 */
export const matchingEvents = {
  clientProfilesChanged: defineEvent(
    'matching.clientProfiles.changed',
    1,
    z.object({ agencyId: z.uuid(), profileIds: z.array(z.uuid()).min(1).max(CLIENT_PROFILE_EVENT_IDS) }),
  ),
  clientProfileMatchDismissed: defineEvent(
    'matching.clientProfileMatch.dismissed',
    1,
    z.object({ matchId: z.uuid(), profileId: z.uuid(), listingId: z.uuid() }),
  ),
};
