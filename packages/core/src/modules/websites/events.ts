import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * websites events (PATTERNS §8), emitted in the transaction that changes the site. IDs only.
 *
 * - `websites.site.created` — a site was added.
 * - `websites.site.changed` — a site's setup changed (policy, filters, prefix, locales, contact, domains, name or
 *   mode); `version` is the new one. Drops the site's cached scope (feed-api), so its answers follow at once;
 *   without it they follow within the cache TTL (60 s).
 */
export const websitesEvents = {
  siteCreated: defineEvent('websites.site.created', 1, z.object({ siteId: z.uuid(), agencyId: z.uuid() })),
  siteChanged: defineEvent(
    'websites.site.changed',
    1,
    z.object({ siteId: z.uuid(), agencyId: z.uuid(), version: z.number().int() }),
  ),
};
