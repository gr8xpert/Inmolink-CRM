import { subscribe } from '@inmolink/platform/outbox';
import * as search from '../search';
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
  ];
}

export function unregisterDedupeSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
