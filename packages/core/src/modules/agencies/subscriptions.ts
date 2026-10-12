import { subscribe } from '@inmolink/platform/outbox';
import { agenciesEvents } from './events';
import { invalidateAgencySettings } from './settings';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → settings cache invalidation (S1-06): `agencies.settings.changed` bumps the agency's settings
 * tag, so every process reloads on its next `getAgencySettings`. Idempotent (a repeated delivery only
 * bumps the tag again). The tenant is `meta.agencyId` (RLS-checked when the event was written), not a
 * payload field. Called once by the worker.
 */
export function registerAgenciesSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(agenciesEvents.settingsChanged, (_payload, meta) => invalidateAgencySettings(meta.agencyId), {
      name: 'agencies.settingsCache.invalidate',
    }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterAgenciesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
