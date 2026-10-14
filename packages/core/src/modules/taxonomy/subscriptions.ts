import { subscribe } from '@inmolink/platform/outbox';
import { taxonomyEvents } from './events';
import { invalidateTaxonomyCache } from './tree';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → taxonomy cache invalidation (S2-03): `taxonomy.data.changed` bumps the `taxonomy` tag, so
 * every process reloads on its next read (in-process copies within 60 s). Idempotent: a repeated
 * delivery only bumps the tag again. Called once by the worker.
 */
export function registerTaxonomySubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(taxonomyEvents.changed, () => invalidateTaxonomyCache(), { name: 'taxonomy.cache.invalidate' }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterTaxonomySubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
