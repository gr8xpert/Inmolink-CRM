import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * properties events (PATTERNS §8): emitted with `emit(ctx.tx, …)` in the transaction of the change, so an event
 * exists if and only if the change committed. IDs and field names only; consumers (search, read models,
 * matching, S3+) load the listing and ignore stale `version`s.
 */
const listing = { listingId: z.uuid(), agencyId: z.uuid(), version: z.number().int() };

export const propertiesEvents = {
  created: defineEvent('properties.listing.created', 1, z.object(listing)),
  /** Any field change; `changed` names the DTO fields (`price`, `visibility`, …). */
  updated: defineEvent('properties.listing.updated', 1, z.object({ ...listing, changed: z.array(z.string()) })),
  statusChanged: defineEvent(
    'properties.listing.statusChanged',
    1,
    z.object({ ...listing, from: z.string().nullable(), to: z.string() }),
  ),
  visibilityChanged: defineEvent(
    'properties.listing.visibilityChanged',
    1,
    z.object({ ...listing, visibility: z.string(), shareScope: z.string() }),
  ),
  deleted: defineEvent('properties.listing.deleted', 1, z.object(listing)),
  restored: defineEvent('properties.listing.restored', 1, z.object(listing)),
};
