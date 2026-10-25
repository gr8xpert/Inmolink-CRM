import { subscribe } from '@inmolink/platform/outbox';
import { aiFeaturesEvents } from './events';
import { aiFeaturesJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

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
