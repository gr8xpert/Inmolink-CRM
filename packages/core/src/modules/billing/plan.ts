import { FREE_PLAN, type SubscriptionStatus } from '@inmolink/contracts';

/** Statuses during which the subscription's plan is in force (dunning grace for PAST_DUE: S13-02). */
const LIVE: ReadonlySet<SubscriptionStatus> = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/** What the webhook job records when no item is a catalog plan price (never Stripe metadata): Free until fixed. */
export const UNKNOWN_PLAN = 'unknown';

/** The plan in force for a subscription row (or none): its plan while live, else Free — data is never touched. */
export function effectivePlan(sub: { planCode: string; status: SubscriptionStatus } | null): string {
  return sub && LIVE.has(sub.status) && sub.planCode !== UNKNOWN_PLAN ? sub.planCode : FREE_PLAN;
}
