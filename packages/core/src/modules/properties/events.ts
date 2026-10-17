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
  /** S4-F3: a listing soft-deleted past its restore window is gone for good (rows and children deleted). */
  purged: defineEvent('properties.listing.purged', 1, z.object({ listingId: z.uuid(), agencyId: z.uuid() })),
  /**
   * S3-08: the listing has gone 90 days without a confirmation (once per lapse; the freshness sweep). The agent
   * is prompted in the editor; notifications (later) tell them.
   */
  confirmationDue: defineEvent('properties.listing.confirmationDue', 1, z.object(listing)),
  /**
   * S3-10: an agency saved or removed its own text for a listing, development or unit it presents (one locale).
   * Its website and selections (S7-02, S12-04) refresh that target's text for this agency only.
   */
  overrideChanged: defineEvent(
    'properties.listingOverride.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      targetKind: z.enum(['LISTING', 'DEVELOPMENT', 'UNIT']),
      targetId: z.uuid(),
      locale: z.string(),
    }),
  ),
  /** A member asked for a bulk action (S3-07); the subscription queues `properties.runBulkAction`. */
  bulkRequested: defineEvent(
    'properties.bulkAction.requested',
    1,
    z.object({ bulkActionId: z.uuid(), agencyId: z.uuid(), userId: z.uuid() }),
  ),
};
