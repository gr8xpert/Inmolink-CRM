import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * websites events (PATTERNS §8), emitted in the transaction that changes the site. IDs only.
 *
 * - `websites.site.created` — a site was added.
 * - `websites.site.changed` — a site's setup changed (policy, filters, prefix, locales, contact, domains, name or
 *   mode); `version` is the new one. Drops the site's cached scope (feed-api), so its answers follow at once;
 *   without it they follow within the cache TTL (60 s).
 * - `websites.lead.received` (S7-05) — a website form created an inbound lead (feed-api's intake transaction, as
 *   `app_intake`): the visitor's acknowledgement and the agency's notification follow in worker jobs.
 * - `websites.feed.changed` (S7-07) — a site's XML feed token was set (`ROTATED`, also the first one) or revoked:
 *   the feed is generated for a new token, and the CDN copies of the old URL are purged.
 */
export const websitesEvents = {
  siteCreated: defineEvent('websites.site.created', 1, z.object({ siteId: z.uuid(), agencyId: z.uuid() })),
  siteChanged: defineEvent(
    'websites.site.changed',
    1,
    z.object({ siteId: z.uuid(), agencyId: z.uuid(), version: z.number().int() }),
  ),
  feedChanged: defineEvent(
    'websites.feed.changed',
    1,
    z.object({ siteId: z.uuid(), agencyId: z.uuid(), action: z.enum(['ROTATED', 'REVOKED']) }),
  ),
  leadReceived: defineEvent(
    'websites.lead.received',
    1,
    z.object({ leadId: z.uuid(), agencyId: z.uuid(), siteId: z.uuid() }),
  ),
};
