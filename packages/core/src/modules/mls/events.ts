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
};
