import { SubscriptionStatus } from '@inmolink/contracts';
import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * billing events (PATTERNS §8): `defineEvent('billing.<entity>.<verb>', 1, schema)` from
 * `@inmolink/platform/outbox`, emitted with `emit(ctx.tx, …)` in the same transaction. IDs only.
 */
export const billingEvents = {
  /**
   * S13-01: the agency's plan or subscription status changed (the webhook job applied Stripe's state). `plan` is the
   * plan in force now (`free` once a subscription ended). Plan gates, seats and onboarding react to it (S13-02, S13-04).
   */
  subscriptionChanged: defineEvent(
    'billing.subscription.changed',
    1,
    z.object({ agencyId: z.uuid(), plan: z.string().max(40), status: SubscriptionStatus }),
  ),
};
