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
};
