import { subscribe } from '@inmolink/platform/outbox';
import * as search from '../search';
import { aiFeaturesEvents } from './events';
import { aiFeaturesJobs, whiteLabelJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;
let unsubscribeWhiteLabel: (() => void)[] | undefined;

/**
 * Outbox → ai-features worker (S12-02). Each `aiFeatures.listingStudio.requested` event becomes one job (job ID =
 * the request id): SINGLE → `generateListingCopy`, BULK → `submitListingStudioBatch`. The tenant is `meta.agencyId`
 * (RLS-checked when the event was written), the fair-share group. Called once by the worker.
 */
export function registerAiFeaturesSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      aiFeaturesEvents.listingStudioRequested,
      (payload, meta) => {
        const { mode, ...rest } = payload;
        const p = { ...rest, agencyId: meta.agencyId };
        return mode === 'SINGLE'
          ? aiFeaturesJobs.generateListingCopy.enqueue(p)
          : aiFeaturesJobs.submitListingStudioBatch.enqueue(p);
      },
      { name: 'aiFeatures.listingStudio.run' },
    ),
  ];
}

/** Tests only. */
export function unregisterAiFeaturesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}

/**
 * Outbox → the model pass: what websites show of these targets changed (S7-06's event). Called once by the worker.
 * S13-F7: only the targets network sites show with text new to them (`networkShownIds`): an event without any (a price
 * edit, a re-written row with the same text, a private or own-only change) queues no job. Events from before the field
 * existed name every target, as before.
 */
export function registerWhiteLabelSubscriptions(): void {
  if (unsubscribeWhiteLabel) return;
  unsubscribeWhiteLabel = [
    subscribe(
      search.searchEvents.publicDocsChanged,
      async (payload, meta) => {
        const targetIds = payload.networkShownIds ?? payload.targetIds;
        if (targetIds.length === 0) return;
        await whiteLabelJobs.sanitizeTexts.enqueue({ eventId: meta.eventId, agencyId: payload.agencyId, targetIds });
      },
      { name: 'aiFeatures.whiteLabel.publicDocsChanged' },
    ),
  ];
}

/** Tests. */
export function unregisterWhiteLabelSubscriptions(): void {
  for (const off of unsubscribeWhiteLabel ?? []) off();
  unsubscribeWhiteLabel = undefined;
}
