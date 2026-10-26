import { FREE_PLAN, type PlanFeature, type PlanQuota } from '@inmolink/contracts';

/** What the webhook job records when no item is a catalog plan price (never Stripe metadata): Free until fixed. */
export const UNKNOWN_PLAN = 'unknown';

/**
 * The plan a recorded plan code stands for: an unknown price (or none) is Free — data is never touched.
 * S14-F1: only this mapping. Whether a subscription is live (status, dunning grace) and which plan is in force (grants
 * count) is decided in SQL only: `repo.plansInForce` / `service.planOf`.
 */
export function effectivePlan(planCode: string | null | undefined): string {
  return !planCode || planCode === UNKNOWN_PLAN ? FREE_PLAN : planCode;
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
