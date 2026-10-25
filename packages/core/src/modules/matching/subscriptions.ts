import { subscribe } from '@inmolink/platform/outbox';
import * as search from '../search';
import { matchingJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → matching (S5-06, called once by the worker): each `search.listings.changed` event (listings whose read
 * models were just written or dropped, already debounced by the read-model queue) becomes one
 * `matching.matchListings` job — job ID = the event's id, so a redelivered event adds nothing; the tenant (fair-share
 * group) is the listings' agency.
 */
export function registerMatchingSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      search.searchEvents.listingsChanged,
      (payload, meta) =>
        matchingJobs.matchListings.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          listingIds: payload.listingIds,
        }),
      { name: 'matching.savedSearchAlerts' },
    ),
  ];
}

export function unregisterMatchingSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
