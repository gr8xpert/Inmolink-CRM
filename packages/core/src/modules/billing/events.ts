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
  /**
   * S13-02: the agency's plan in force changed without a subscription change — a trial started, a grant started, ended
   * or was revoked. `plan` is the plan in force now (`free` after a trial ends: data is never touched).
   */
  planChanged: defineEvent(
    'billing.plan.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      plan: z.string().max(40),
      reason: z.enum(['TRIAL_STARTED', 'GRANT_STARTED', 'GRANT_ENDED']),
    }),
  ),
  /**
   * S13-02: a payment failed and the subscription is past due. The plan stays until `graceEndsAt` (no access cut
   * mid-deal without notice): the billing page shows the date, Stripe retries the payment and emails the customer.
   */
  dunningStarted: defineEvent(
    'billing.dunning.started',
    1,
    z.object({ agencyId: z.uuid(), plan: z.string().max(40), graceEndsAt: z.iso.datetime() }),
  ),
};
