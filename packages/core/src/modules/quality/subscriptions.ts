import { subscribe } from '@inmolink/platform/outbox';
import * as media from '../media';
import * as properties from '../properties';
import { enqueueRecompute } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Edited fields (`properties.listing.updated` → `changed`) the score never reads (S4-F2): an edit of only these —
 * every bulk action but STATUS sets one — queues no recompute, so a 5,000-listing bulk price change costs none.
 * Anything not listed (a new field included) recomputes.
 */
export const SCORE_IGNORED_FIELDS: ReadonlySet<string> = new Set([
  'price',
  'commission',
  'split',
  'owner',
  'tags',
  'visibility',
  'shareScope',
  'lockedFields',
  'private',
]);

/** Whether an edit of `changed` can move the score. */
export const scoreMayChange = (changed: readonly string[]) => changed.some((f) => !SCORE_IGNORED_FIELDS.has(f));

const { propertiesEvents } = properties;

/**
 * Outbox → quality worker (S3-08): every change the score reads — a listing created, edited (fields the score reads,
 * translations,
 * features, confirmation), restored or moved through its lifecycle, its photos added or removed
 * (`media.object.referencesChanged`) or edited (`media.listing.changed`: a floor plan turned photo), or its confirmation falling due — queues the
 * listing in `quality_queue` (debounced, S6-F3) and asks for its agency's `quality.recomputeListings` run. The tenant is `meta.agencyId` (RLS-checked when the event was
 * written), the fair-share group. Called once by the worker.
 */
export function registerQualitySubscriptions(): void {
  if (unsubscribe) return;
  const recompute = (payload: { listingId: string }, meta: { agencyId: string }) =>
    enqueueRecompute(payload.listingId, meta.agencyId);
  unsubscribe = [
    subscribe(propertiesEvents.created, recompute, { name: 'quality.recompute.created' }),
    subscribe(
      propertiesEvents.updated,
      async (payload, meta) => {
        if (scoreMayChange(payload.changed)) await recompute(payload, meta);
      },
      { name: 'quality.recompute.updated' },
    ),
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
