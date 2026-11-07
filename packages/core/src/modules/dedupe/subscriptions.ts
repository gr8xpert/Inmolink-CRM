import { subscribe } from '@inmolink/platform/outbox';
import * as search from '../search';
import { dedupeEvents } from './events';
import { dedupeJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → dedupe (R2-03a, called once by the worker): each `search.listings.changed` event (listings whose read
 * models were just written or dropped, debounced by the read-model queue; a media change rebuilds the read model and
 * so arrives here too) becomes one `dedupe.rescoreListings` job — job ID = the event's id, group = the agency.
 */
export function registerDedupeSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      search.searchEvents.listingsChanged,
      (payload, meta) =>
        dedupeJobs.rescoreListings.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          listingIds: payload.listingIds,
        }),
      { name: 'dedupe.rescore' },
    ),
    // R2-03b: clusters follow the pairs; members' and staff's decisions are applied by the worker
    subscribe(
      dedupeEvents.pairsChanged,
      (payload, meta) => dedupeJobs.recluster.enqueue({ eventId: meta.eventId, listingIds: payload.listingIds }),
      { name: 'dedupe.recluster' },
    ),
    subscribe(
      dedupeEvents.reviewDecided,
      (payload, meta) => dedupeJobs.applyReview.enqueue({ agencyId: meta.agencyId, reviewId: payload.reviewId }),
      { name: 'dedupe.applyReview' },
    ),
    subscribe(
      dedupeEvents.disputeResolved,
      (payload, meta) => dedupeJobs.applyDispute.enqueue({ agencyId: meta.agencyId, disputeId: payload.disputeId }),
      { name: 'dedupe.applyDispute' },
    ),
  ];
}

export function unregisterDedupeSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
