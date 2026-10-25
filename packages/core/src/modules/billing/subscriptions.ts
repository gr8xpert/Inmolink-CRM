import { subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import { billingJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → billing worker (S13-02, called once by the worker). A new agency's first onboarding (its company details
 * saved for the first time) starts its trial — `billing.startTrial` skips agencies with billing history (migrated,
 * founding, already subscribed). The tenant is `meta.agencyId` (RLS-checked when the event was written).
 */
export function registerBillingSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      agencies.agenciesEvents.detailsUpdated,
      async (payload, meta) => {
        if (payload.firstOnboarding) await billingJobs.startTrial.enqueue({ agencyId: meta.agencyId });
      },
      { name: 'billing.trial.start' },
    ),
  ];
}

export function unregisterBillingSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
