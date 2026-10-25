import { cache } from '@inmolink/platform/cache';
import { subscribe } from '@inmolink/platform/outbox';
import * as billing from '../billing';
import { websitesEvents } from './events';
import { websitesJobs } from './jobs';
import { siteCacheKey } from './service';

let unsubscribe: (() => void)[] | undefined;

/**
 * Outbox → site cache invalidation (S7-01), and (S13-F21) the agency's plan on its sites after billing's plan events
 * or a new site: a changed site leaves the shared lookup cache when its event is
 * delivered; in-process copies elsewhere expire within `SITE_CACHE.LOCAL_TTL_SECONDS`. Called once by the worker;
 * idempotent.
 */
export function registerWebsitesSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(websitesEvents.siteChanged, (payload) => cache.delete(siteCacheKey(payload.siteId)), {
      name: 'websites.siteCache.changed',
    }),
    // S13-F21: the agency's plan in force on its sites (AI budgets, the website API cut-off of a plan without it).
    subscribe(
      billing.billingEvents.planChanged,
      async (_p, meta) => {
        await websitesJobs.syncSitePlan.enqueue({ agencyId: meta.agencyId, key: meta.eventId });
      },
      { name: 'websites.sitePlan.planChanged' },
    ),
    subscribe(
      billing.billingEvents.subscriptionChanged,
      async (_p, meta) => {
        await websitesJobs.syncSitePlan.enqueue({ agencyId: meta.agencyId, key: meta.eventId });
      },
      { name: 'websites.sitePlan.subscriptionChanged' },
    ),
    subscribe(
      websitesEvents.siteCreated,
      async (_p, meta) => {
        await websitesJobs.syncSitePlan.enqueue({ agencyId: meta.agencyId, key: meta.eventId });
      },
      { name: 'websites.sitePlan.siteCreated' },
    ),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterWebsitesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
