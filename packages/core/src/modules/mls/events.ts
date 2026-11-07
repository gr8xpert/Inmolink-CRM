import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * mls events (PATTERNS §8), emitted in the transaction of the change. IDs only — never the client, never a fingerprint.
 *
 * - `mls.registration.created` (S11-01) — the introducer (`agencyId`) registered a client for a target of
 *   `targetAgencyId`, valid until `expiresMs` (epoch ms). For the owner's notification (S11-04) and the deal flow.
 * - `mls.viewing.changed` (S11-02) — a viewing request between `introducerAgencyId` and `ownerAgencyId` was requested,
 *   accepted, declined, rescheduled, cancelled, completed or expired (`action`) by `by`. `agencyId` is the acting side's
 *   agency (the introducer's for `SYSTEM`). `termsAccepted`: this change bound both sides to the terms snapshot (the
 *   accepted-terms PDF, S12-05). Consumers: the other side's notification (both sides' on expiry).
 * - `mls.deal.changed` (R2-04a) — a deal between `introducerAgencyId` and `ownerAgencyId` was opened, moved, repriced,
 *   confirmed or withdrawn, completed (the handshake), fell through, or mediated by staff (`action`), by `by`.
 *   `agencyId` is the acting side's agency (one event per party for a staff mediation). For the other side's
 *   notification (R2-04b / c). IDs only.
 */
export const mlsEvents = {
  registrationCreated: defineEvent(
    'mls.registration.created',
    1,
    z.object({
      agencyId: z.uuid(),
      registrationId: z.uuid(),
      targetAgencyId: z.uuid(),
      targetKind: z.enum(['LISTING', 'DEVELOPMENT']),
      targetId: z.uuid(),
      expiresMs: z.number().int(),
    }),
  ),
  viewingChanged: defineEvent(
    'mls.viewing.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      requestId: z.uuid(),
      introducerAgencyId: z.uuid(),
      ownerAgencyId: z.uuid(),
      action: z.enum(['REQUESTED', 'ACCEPTED', 'DECLINED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'EXPIRED']),
      by: z.enum(['INTRODUCER', 'OWNER', 'SYSTEM']),
      /** The member who acted (null for the system). */
      userId: z.uuid().nullable(),
      termsAccepted: z.boolean(),
    }),
  ),
  dealChanged: defineEvent(
    'mls.deal.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      dealId: z.uuid(),
      introducerAgencyId: z.uuid(),
      ownerAgencyId: z.uuid(),
      action: z.enum([
        'OPENED',
        'ADVANCED',
        'PRICE_CHANGED',
        'CONFIRMED',
        'WITHDRAWN',
        'COMPLETED',
        'FELL_THROUGH',
        'MEDIATED',
        // R2-04c: a party raised a dispute (the other party is told); staff resolved one (the raising agency is told)
        'DISPUTED',
        'DISPUTE_RESOLVED',
      ]),
      by: z.enum(['INTRODUCER', 'OWNER', 'STAFF']),
      /** The member or staff user who acted. */
      userId: z.uuid().nullable(),
    }),
  ),
  /**
   * `mls.dealDocument.removed` (R2-04b) — the uploading agency (`agencyId`) removed a document of a deal (both copies
   * marked removed in the same statement). Consumer: `mls.deleteDealDocumentObject` (the object leaves the bucket). IDs
   * only.
   */
  dealDocumentRemoved: defineEvent(
    'mls.dealDocument.removed',
    1,
    z.object({ agencyId: z.uuid(), dealId: z.uuid(), documentId: z.uuid() }),
  ),
};
