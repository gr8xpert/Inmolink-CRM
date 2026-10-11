import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * agencies events (PATTERNS §8), emitted in the same transaction as the change. IDs only. Sign-up
 * creates the agency inside the `app_auth` transaction, which may only append `identity.*` events:
 * `identity.user.registered` covers it.
 */
export const agenciesEvents = {
  /** Company details saved (onboarding or a later edit). Staff verification (S1-03) reacts to the first. */
  detailsUpdated: defineEvent(
    'agencies.details.updated',
    1,
    z.object({ agencyId: z.uuid(), version: z.number().int(), firstOnboarding: z.boolean() }),
  ),
  /** The agency submitted its details and documents for staff verification (S1-03). */
  verificationSubmitted: defineEvent(
    'agencies.verification.submitted',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
  ),
  /** Staff approved or rejected a request (S1-03). The agency's admins get an email. */
  verificationDecided: defineEvent(
    'agencies.verification.decided',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid(), decision: z.enum(['APPROVED', 'REJECTED']) }),
  ),
  /**
   * The agency's status changed (S1-03: PENDING → VERIFIED; suspension later). Caches of anything the
   * status gates (API keys S1-05, site configs) invalidate on it; `withMemberCtx` reads it per request.
   */
  statusChanged: defineEvent(
    'agencies.status.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      from: z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']),
      to: z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']),
      version: z.number().int(),
    }),
  ),
};
