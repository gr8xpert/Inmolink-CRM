import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * properties events (PATTERNS §8): emitted with `emit(ctx.tx, …)` in the transaction of the change, so an event
 * exists if and only if the change committed. IDs and field names only; consumers (search, read models,
 * matching, S3+) load the listing and ignore stale `version`s.
 */
const listing = { listingId: z.uuid(), agencyId: z.uuid(), version: z.number().int() };

/**
 * S13-F14: the `properties.listing.updated` fields the listing's copy is written from (type, location, specs, energy
 * rating, features) — a change to one also emits `factsChanged`. Price, status, visibility or text changes do not.
 */
export const COPY_FACT_FIELDS: ReadonlySet<string> = new Set([
  'transactionType',
  'propertyType',
  'location',
  'specs',
  'energyRating',
  'features',
]);

/** Listing ids per `properties.listings.imported` event: 250 × 39 bytes stays under the 10 KB payload cap. */
export const IMPORTED_PER_EVENT = 250;

export const propertiesEvents = {
  created: defineEvent('properties.listing.created', 1, z.object(listing)),
  /** Any field change; `changed` names the DTO fields (`price`, `visibility`, …). */
  updated: defineEvent('properties.listing.updated', 1, z.object({ ...listing, changed: z.array(z.string()) })),
  /**
   * S13-F14: a listing was created (`created`) or one of its `COPY_FACT_FIELDS` changed — emitted with `created` /
   * `updated` in the same statement. Its subscriber (ai-features) may queue AI drafts, so it is never replayed
   * (`REPLAY_REFUSED_TYPES`), unlike `created` / `updated`.
   */
  factsChanged: defineEvent('properties.listing.factsChanged', 1, z.object({ ...listing, created: z.boolean() })),
  statusChanged: defineEvent(
    'properties.listing.statusChanged',
    1,
    z.object({ ...listing, from: z.string().nullable(), to: z.string() }),
  ),
  visibilityChanged: defineEvent(
    'properties.listing.visibilityChanged',
    1,
    z.object({
      ...listing,
      visibility: z.string(),
      shareScope: z.string(),
      /**
       * S13-04: true when the freshness sweep hid the listing from the network (visibility unchanged); absent on every
       * other change (and on events emitted before it existed). Lets "shared a listing" consumers skip hides.
       */
      networkHidden: z.boolean().optional(),
    }),
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
  /**
   * S6-02: a feed run created, updated or withdrew these listings of the agency (created, updated, statusChanged
   * and visibility are not emitted per listing for imports). Up to `IMPORTED_PER_EVENT` ids, so one queue write and
   * one throttled build request per event replace one per listing; consumers reload each listing's current state.
   */
  imported: defineEvent(
    'properties.listings.imported',
    1,
    z.object({ agencyId: z.uuid(), runId: z.uuid(), listingIds: z.array(z.uuid()).min(1).max(IMPORTED_PER_EVENT) }),
  ),
  /** A member asked for a bulk action (S3-07); the subscription queues `properties.runBulkAction`. */
  bulkRequested: defineEvent(
    'properties.bulkAction.requested',
    1,
    z.object({ bulkActionId: z.uuid(), agencyId: z.uuid(), userId: z.uuid() }),
  ),
};
