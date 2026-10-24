import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * mls events (PATTERNS §8), emitted in the transaction of the change. IDs only — never the client, never a fingerprint.
 *
 * - `mls.registration.created` (S11-01) — the introducer (`agencyId`) registered a client for a target of
 *   `targetAgencyId`, valid until `expiresMs` (epoch ms). For the owner's notification (S11-04) and the deal flow.
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
};
