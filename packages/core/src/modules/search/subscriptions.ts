import { subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as media from '../media';
import * as properties from '../properties';
import { queueReadModel, READ_MODEL_DEBOUNCE_MS, searchJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Development fields its units' documents never show: an edit of only these (a commission change, the "prices are
 * current" confirmation of a price-list approval — whose price changes arrive as `priceList.approved`) rebuilds
 * nothing.
 */
export const DEVELOPMENT_IGNORED_FIELDS: ReadonlySet<string> = new Set([
  'commission',
  'lastVerifiedAt',
  'managedBy',
  'ref',
]);

const { propertiesEvents } = properties;
const { developmentsEvents } = developments;

/**
 * Outbox → read models (S5-01, PATTERNS §14). Every change a read model shows queues a debounced rebuild of its
 * target (S5-F4: a `read_model_queue` row, rebuilt with the agency's other due targets in batches): a listing created, edited, moved through its lifecycle, shared, deleted, restored or purged, or its media
 * changed; a unit created, edited, repriced or deleted; a price list approved (all its development's units); a
 * development's text, place or access changed or the
 * development deleted (all its units); the agency's content locales changed (all its documents). The rebuild reads
 * current state, so a duplicate or late event costs one rebuild and changes nothing. The tenant is `meta.agencyId`
 * (RLS-checked when the event was written), the fair-share group. Called once by the worker.
 *
 * Not subscribed: overrides (applied per site when served, S7-02) and taxonomy renames (rare; reach documents with
 * the target's next rebuild or `pnpm ops:rebuild-read-models`).
 */
export function registerSearchSubscriptions(): void {
  if (unsubscribe) return;
  const listing = (payload: { listingId: string }, meta: { agencyId: string }) =>
    queueReadModel('LISTING', payload.listingId, meta.agencyId);
  const unit = (payload: { unitId: string }, meta: { agencyId: string }) =>
    queueReadModel('UNIT', payload.unitId, meta.agencyId);
  const development = (payload: { developmentId: string; changed?: string[] }, meta: { agencyId: string }) =>
    searchJobs.buildDevelopmentReadModels.enqueue(
      { developmentId: payload.developmentId, agencyId: meta.agencyId },
      { debounceMs: READ_MODEL_DEBOUNCE_MS, debounceKey: payload.developmentId },
    );
  unsubscribe = [
    subscribe(propertiesEvents.created, listing, { name: 'search.readModel.listingCreated' }),
    subscribe(propertiesEvents.updated, listing, { name: 'search.readModel.listingUpdated' }),
    subscribe(propertiesEvents.statusChanged, listing, { name: 'search.readModel.listingStatusChanged' }),
    subscribe(propertiesEvents.visibilityChanged, listing, { name: 'search.readModel.listingVisibilityChanged' }),
    subscribe(propertiesEvents.deleted, listing, { name: 'search.readModel.listingDeleted' }),
    subscribe(propertiesEvents.restored, listing, { name: 'search.readModel.listingRestored' }),
    subscribe(propertiesEvents.purged, listing, { name: 'search.readModel.listingPurged' }),
    subscribe(media.mediaEvents.referencesChanged, listing, { name: 'search.readModel.media' }),
    subscribe(media.mediaEvents.listingChanged, listing, { name: 'search.readModel.mediaEdited' }),
    subscribe(developmentsEvents.unitCreated, unit, { name: 'search.readModel.unitCreated' }),
    subscribe(developmentsEvents.unitUpdated, unit, { name: 'search.readModel.unitUpdated' }),
    subscribe(developmentsEvents.unitStatusChanged, unit, { name: 'search.readModel.unitStatusChanged' }),
    subscribe(developmentsEvents.unitPriceChanged, unit, { name: 'search.readModel.unitPriceChanged' }),
    subscribe(developmentsEvents.unitDeleted, unit, { name: 'search.readModel.unitDeleted' }),
    // S5-F3: one event for a whole repricing (no per-unit events): every unit of the development is rebuilt.
    subscribe(developmentsEvents.priceListApproved, development, { name: 'search.readModel.priceListApproved' }),
    subscribe(
      developmentsEvents.updated,
      async (payload, meta) => {
        if (payload.changed.some((f) => !DEVELOPMENT_IGNORED_FIELDS.has(f))) await development(payload, meta);
      },
      { name: 'search.readModel.developmentUpdated' },
    ),
    subscribe(developmentsEvents.accessChanged, development, { name: 'search.readModel.developmentAccess' }),
    subscribe(developmentsEvents.deleted, development, { name: 'search.readModel.developmentDeleted' }),
    subscribe(
      agencies.agenciesEvents.settingsChanged,
      async (payload, meta) => {
        if (!payload.changed.includes('enabledLocales')) return;
        await searchJobs.buildAgencyReadModels.enqueue(
          { agencyId: meta.agencyId },
          { debounceMs: 10_000, debounceKey: meta.agencyId },
        );
      },
      { name: 'search.readModel.agencyLocales' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterSearchSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
