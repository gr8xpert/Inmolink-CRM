import { subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as crm from '../crm';
import * as presentations from '../presentations';
import * as search from '../search';
import { matchingEvents } from './events';
import { clientMatchJobs, clientProfileJobs, feedbackJobs, matchingJobs, profileEmbeddingJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → matching (S5-06, called once by the worker): each `search.listings.changed` event (listings whose read
 * models were just written or dropped, already debounced by the read-model queue) becomes one
 * `matching.matchListings` job — job ID = the event's id, so a redelivered event adds nothing; the tenant (fair-share
 * group) is the listings' agency. An agency's status change (verified, suspended) re-keys its saved searches
 * (`matching.rekeyAgency`: network keys only while it takes part in the network). R2-01b: a changed client
 * profile (`matching.clientProfiles.changed`) is re-embedded (`matching.embedProfiles`). R2-02a: a contact merge
 * (`crm.contact.merged`) moves the closed contact's client profiles to the survivor, a contact erasure
 * (`crm.contact.erased`) deletes its profiles and their vectors (one job per event, job ID = the event's id). R2-02b:
 * the same two events also run the match engine (`matching.matchListingsToProfiles`, `matching.matchProfilesToListings`).
 * R2-02c: a client's like / unlike on a selection (`presentations.selection.interacted`) and a dismissed match
 * (`matching.clientProfileMatch.dismissed`) feed the learned boost (`matching.selectionFeedback`,
 * `matching.dismissalFeedback`).
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
    // R2-02b: the same batch against the client profiles that may see it (job id from the event).
    subscribe(
      search.searchEvents.listingsChanged,
      (payload, meta) =>
        clientMatchJobs.matchListingsToProfiles.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          listingIds: payload.listingIds,
        }),
      { name: 'matching.clientProfileMatches.listings' },
    ),
    // R2-02b: a changed client profile is matched against the live listings (job id from the event).
    subscribe(
      matchingEvents.clientProfilesChanged,
      (payload, meta) =>
        clientMatchJobs.matchProfilesToListings.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          profileIds: payload.profileIds,
        }),
      { name: 'matching.clientProfileMatches.profiles' },
    ),
    // R2-01b: a changed client profile → one `matching.embedProfiles` job per event (job id = the event's id).
    subscribe(
      matchingEvents.clientProfilesChanged,
      (payload, meta) =>
        profileEmbeddingJobs.embedProfiles.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          profileIds: payload.profileIds,
        }),
      { name: 'matching.profileEmbeddings' },
    ),
    subscribe(
      crm.crmEvents.contactMerged,
      (payload, meta) =>
        clientProfileJobs.repointClientProfiles.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          survivorId: payload.survivorId,
          mergedId: payload.mergedId,
        }),
      { name: 'matching.clientProfiles.contactMerged' },
    ),
    subscribe(
      crm.crmEvents.contactErased,
      (payload, meta) =>
        clientProfileJobs.eraseContactProfiles.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          contactId: payload.contactId,
        }),
      { name: 'matching.clientProfiles.contactErased' },
    ),
    // R2-02c: likes / unlikes (the item named) → the learned boost of the selection's contact's profiles.
    subscribe(
      presentations.presentationsEvents.selectionInteracted,
      async (payload, meta) => {
        if ((payload.kind !== 'LIKE' && payload.kind !== 'UNLIKE') || !payload.targetId) return;
        await feedbackJobs.selectionFeedback.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          selectionId: payload.selectionId,
          targetId: payload.targetId,
        });
      },
      { name: 'matching.boost.selection' },
    ),
    // R2-02c: a dismissed match → the learned boost of its profile.
    subscribe(
      matchingEvents.clientProfileMatchDismissed,
      (payload, meta) =>
        feedbackJobs.dismissalFeedback.enqueue({
          eventId: meta.eventId,
          agencyId: meta.agencyId,
          matchId: payload.matchId,
        }),
      { name: 'matching.boost.dismissal' },
    ),
    subscribe(
      agencies.agenciesEvents.statusChanged,
      (payload) => matchingJobs.rekeyAgency.enqueue({ agencyId: payload.agencyId }),
      { name: 'matching.rekeyOnStatus' },
    ),
  ];
}

export function unregisterMatchingSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
