import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * developments events (PATTERNS §8): emitted with `emit(ctx.tx, …)` in the transaction of the change, so an event
 * exists if and only if the change committed. IDs and small parameters only; consumers (search, read models,
 * matching, notifications) load the row and ignore stale `version`s.
 */
const development = { developmentId: z.uuid(), agencyId: z.uuid(), version: z.number().int() };
const unit = { unitId: z.uuid(), developmentId: z.uuid(), agencyId: z.uuid(), version: z.number().int() };
const unitStatus = z.enum(['AVAILABLE', 'RESERVED', 'SOLD']);
const priceList = { priceListId: z.uuid(), developmentId: z.uuid(), agencyId: z.uuid(), version: z.number().int() };

export const developmentsEvents = {
  created: defineEvent('developments.development.created', 1, z.object(development)),
  /** Any field change; `changed` names the DTO fields. */
  updated: defineEvent(
    'developments.development.updated',
    1,
    z.object({ ...development, changed: z.array(z.string()) }),
  ),
  /** OPEN / PRIVATE_NETWORK or the allowed agencies changed: who reads it changed. */
  accessChanged: defineEvent('developments.development.accessChanged', 1, z.object(development)),
  deleted: defineEvent('developments.development.deleted', 1, z.object(development)),
  unitCreated: defineEvent('developments.unit.created', 1, z.object(unit)),
  /** Any field change of a unit; status and price changes also emit their own event. */
  unitUpdated: defineEvent('developments.unit.updated', 1, z.object({ ...unit, changed: z.array(z.string()) })),
  unitStatusChanged: defineEvent(
    'developments.unit.statusChanged',
    1,
    z.object({ ...unit, from: unitStatus, to: unitStatus }),
  ),
  /**
   * A manual price edit (`priceListId` null). An approved price list emits no per-unit events since S5-F3:
   * `priceList.approved` stands for all the units it changed (their history rows name it).
   */
  unitPriceChanged: defineEvent(
    'developments.unit.priceChanged',
    1,
    z.object({ ...unit, priceListId: z.uuid().nullable() }),
  ),
  unitDeleted: defineEvent(
    'developments.unit.deleted',
    1,
    z.object({ unitId: z.uuid(), developmentId: z.uuid(), agencyId: z.uuid() }),
  ),
  /** A new price list version was uploaded (diff computed, waiting for review). */
  priceListCreated: defineEvent('developments.priceList.created', 1, z.object(priceList)),
  /** A person approved the version and its prices and statuses were applied: reload the development's units. */
  priceListApproved: defineEvent('developments.priceList.approved', 1, z.object(priceList)),
  /** S4-F4: the row is gone; the worker deletes the object (`developments.deleteDocumentObject`). */
  documentDeleted: defineEvent(
    'developments.document.deleted',
    1,
    z.object({ documentId: z.uuid(), developmentId: z.uuid(), agencyId: z.uuid() }),
  ),
};
