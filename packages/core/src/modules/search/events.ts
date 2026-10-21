import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/** Targets per `search.publicDocs.changed` event: keeps the payload (and the purge job's) well under 10 KB. */
export const PUBLIC_DOCS_EVENT_TARGETS = 100;

/**
 * search events (PATTERNS §8): `defineEvent('search.<entity>.<verb>', 1, schema)` from
 * `@inmolink/platform/outbox`, emitted with `emit(ctx.tx, …)` in the same transaction. IDs only.
 *
 * - `search.publicDocs.changed` (S7-06) — what websites show of these targets may have changed: written with the
 *   read models and the website change log (`listing_public_changes`), one event per owner agency and at most
 *   `PUBLIC_DOCS_EVENT_TARGETS` targets; `developmentIds` are the developments of the changed units still public.
 *   The website API purges its edge cache by these (`websiteApi.purgeEdgeCache`).
 */
export const searchEvents = {
  publicDocsChanged: defineEvent(
    'search.publicDocs.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      targetIds: z.array(z.uuid()).min(1).max(PUBLIC_DOCS_EVENT_TARGETS),
      developmentIds: z.array(z.uuid()).max(PUBLIC_DOCS_EVENT_TARGETS),
    }),
  ),
};
