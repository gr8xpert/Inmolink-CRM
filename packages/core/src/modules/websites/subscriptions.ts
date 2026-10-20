import { cache } from '@inmolink/platform/cache';
import { subscribe } from '@inmolink/platform/outbox';
import { websitesEvents } from './events';
import { siteCacheKey } from './service';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → site cache invalidation (S7-01): a changed site leaves the shared lookup cache when its event is
 * delivered; in-process copies elsewhere expire within `SITE_CACHE.LOCAL_TTL_SECONDS`. Called once by the worker;
 * idempotent.
 */
export function registerWebsitesSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(websitesEvents.siteChanged, (payload) => cache.delete(siteCacheKey(payload.siteId)), {
      name: 'websites.siteCache.changed',
    }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterWebsitesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
