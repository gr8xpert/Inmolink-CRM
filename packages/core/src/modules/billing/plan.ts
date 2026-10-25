import { FREE_PLAN, type PlanFeature, type SubscriptionStatus } from '@inmolink/contracts';

/** Statuses during which the subscription's plan is in force (PAST_DUE only within the dunning grace, S13-02). */
const LIVE: ReadonlySet<SubscriptionStatus> = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/** What the webhook job records when no item is a catalog plan price (never Stripe metadata): Free until fixed. */
export const UNKNOWN_PLAN = 'unknown';

/**
 * The plan a subscription row (or none) puts the agency on: its plan while live, else Free — data is never touched.
 * S13-02: a PAST_DUE one only until `graceStart` (now minus the dunning grace) has not yet passed its `pastDueSince`.
 * Grants are not counted here: `repo.planInForce` is the agency's plan.
 */
export function effectivePlan(
  sub: { planCode: string; status: SubscriptionStatus; pastDueSince?: Date | null } | null,
  graceStart?: Date,
): string {
  if (!sub || !LIVE.has(sub.status) || sub.planCode === UNKNOWN_PLAN) return FREE_PLAN;
  if (sub.status === 'PAST_DUE' && graceStart && sub.pastDueSince && sub.pastDueSince <= graceStart) return FREE_PLAN;
  return sub.planCode;
}

/** A plan of the catalog matrix (PLAN §11): its code, display rank and gated features. */
export interface MatrixPlan {
  code: string;
  rank: number;
  active: boolean;
  features: readonly string[];
}

/**
 * S13-02: whether `plan` includes `feature`, and if not, the cheapest offered (active) plan that does — `null` when
 * none does (an Enterprise-only feature with no catalog plan yet). Pure: the table-driven test runs it on the catalog.
 */
export function planGate(
  matrix: readonly MatrixPlan[],
  plan: string,
  feature: PlanFeature,
): { allowed: true } | { allowed: false; requiredPlan: string | null } {
  if (matrix.find((p) => p.code === plan)?.features.includes(feature)) return { allowed: true };
  const required = [...matrix]
    .filter((p) => p.active && p.features.includes(feature))
    .sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code))[0];
  return { allowed: false, requiredPlan: required?.code ?? null };
}
