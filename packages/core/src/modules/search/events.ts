import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/** Targets per `search.publicDocs.changed` event: keeps the payload (and the purge job's) well under 10 KB. */
export const PUBLIC_DOCS_EVENT_TARGETS = 100;
/** Agencies named in `networkLost` (more: `all`). Twice the preferred-agency cap: before and after one change. */
export const NETWORK_LOST_AGENCIES = 400;

/**
 * search events (PATTERNS §8): `defineEvent('search.<entity>.<verb>', 1, schema)` from
 * `@inmolink/platform/outbox`, emitted with `emit(ctx.tx, …)` in the same transaction. IDs only.
 *
 * - `search.publicDocs.changed` (S7-06) — what websites show of these targets may have changed: written with the
 *   read models and the website change log (`listing_public_changes`), one event per owner agency and at most
 *   `PUBLIC_DOCS_EVENT_TARGETS` targets; `developmentIds` are the developments of the changed units still public.
 *   The website API purges its edge cache by these (`websiteApi.purgeEdgeCache`). S8-F1: `networkLost` — who may
 *   have lost sight of some of these targets on a network site (no longer public, or shared more narrowly): `all`
 *   (every agency: it was shared with ALL) or the preferred agencies that lost it. The website API queues those
 *   partners' live XML feeds, so the target leaves them within minutes. Absent (events from before S8-F1): none.
 */
export const searchEvents = {
  /**
   * S5-06: these listings' read models were written or dropped (one event per owner agency, ≤
   * `PUBLIC_DOCS_EVENT_TARGETS` ids), in the rebuild's transaction — whatever their visibility. The matching worker
   * compares each listing's new state with the last one it saw (a new listing, a price drop, back on the market) and
   * alerts the saved searches it matches. IDs only: the consumer reads the current read models.
   */
  listingsChanged: defineEvent(
    'search.listings.changed',
    1,
    z.object({ agencyId: z.uuid(), listingIds: z.array(z.uuid()).min(1).max(PUBLIC_DOCS_EVENT_TARGETS) }),
  ),
  publicDocsChanged: defineEvent(
    'search.publicDocs.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      targetIds: z.array(z.uuid()).min(1).max(PUBLIC_DOCS_EVENT_TARGETS),
      developmentIds: z.array(z.uuid()).max(PUBLIC_DOCS_EVENT_TARGETS),
      networkLost: z.object({ all: z.boolean(), agencyIds: z.array(z.uuid()).max(NETWORK_LOST_AGENCIES) }).optional(),
    }),
  ),
};
