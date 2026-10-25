import { FREE_PLAN, type PlanFeature, type PlanQuota, type SubscriptionStatus } from '@inmolink/contracts';

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
  /** S13-F21: the plan's quotas (`PlanQuota` keys; a key not listed has no limit). */
  limits?: Readonly<Record<string, number>>;
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

/**
 * S13-F21: whether `needed` items (in use plus the ones being added) fit `plan`'s `quota` plus `extra` (add-on units),
 * and if not, the cheapest offered plan they fit — `null` when none does. A plan that does not list the quota has no
 * limit. Pure: the table-driven test runs it on the catalog.
 */
export function quotaGate(
  matrix: readonly MatrixPlan[],
  plan: string,
  quota: PlanQuota,
  needed: number,
  extra = 0,
): { allowed: true } | { allowed: false; limit: number; requiredPlan: string | null } {
  const fits = (p: MatrixPlan | undefined) => {
    const limit = p ? p.limits?.[quota] : 0;
    return limit === undefined || needed <= limit + extra;
  };
  const current = matrix.find((p) => p.code === plan);
  if (fits(current)) return { allowed: true };
  const required = [...matrix]
    .filter((p) => p.active && (current === undefined || p.rank > current.rank) && fits(p))
    .sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code))[0];
  return { allowed: false, limit: (current?.limits?.[quota] ?? 0) + extra, requiredPlan: required?.code ?? null };
}
