import { subscribe } from '@inmolink/platform/outbox';
import * as media from '../media';
import * as properties from '../properties';
import { enqueueRecompute } from './jobs';

let unsubscribe: (() => void)[] | undefined;

const { propertiesEvents } = properties;

/**
 * Outbox → quality worker (S3-08): every change the score reads — a listing created, edited (fields, translations,
 * features, confirmation), restored or moved through its lifecycle, its photos added or removed
 * (`media.object.referencesChanged`) or edited (`media.listing.changed`: a floor plan turned photo), or its confirmation falling due — queues a debounced
 * `quality.recomputeListing` of that listing. The tenant is `meta.agencyId` (RLS-checked when the event was
 * written), the fair-share group. Called once by the worker.
 */
export function registerQualitySubscriptions(): void {
  if (unsubscribe) return;
  const recompute = (payload: { listingId: string }, meta: { agencyId: string }) =>
    enqueueRecompute(payload.listingId, meta.agencyId);
  unsubscribe = [
    subscribe(propertiesEvents.created, recompute, { name: 'quality.recompute.created' }),
    subscribe(propertiesEvents.updated, recompute, { name: 'quality.recompute.updated' }),
    subscribe(propertiesEvents.restored, recompute, { name: 'quality.recompute.restored' }),
    subscribe(propertiesEvents.statusChanged, recompute, { name: 'quality.recompute.statusChanged' }),
    subscribe(propertiesEvents.confirmationDue, recompute, { name: 'quality.recompute.confirmationDue' }),
    subscribe(media.mediaEvents.referencesChanged, recompute, { name: 'quality.recompute.media' }),
    subscribe(media.mediaEvents.listingChanged, recompute, { name: 'quality.recompute.mediaEdited' }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterQualitySubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
