import { readFileSync } from 'node:fs';
import { FREE_PLAN, PlanFeature, PlanQuota } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { effectivePlan, type MatrixPlan, planGate, quotaGate } from '../plan';

/**
 * The plan matrix (S13-02): the gated features of PLAN §11, the cheapest tier each needs, checked against the bundled
 * catalog (`scripts/ops/billing-catalog.json` — the matrix is data, this table is the plan it must match).
 */
const REQUIRED_TIER: Record<PlanFeature, 'pro' | 'business'> = {
  website_api: 'pro',
  portal_exports: 'pro',
  new_builds_full: 'pro',
  crm_full: 'pro',
  client_matching: 'pro',
  speed_to_lead: 'pro',
  social_posting: 'pro',
  pdfs_and_forms: 'pro',
  client_portal: 'pro',
  reports_standard: 'pro',
  crm_automations: 'business',
  matching_auto_send: 'business',
  chat_agent: 'business',
  crm_copilot: 'business',
  email_campaigns: 'business',
  ai_video: 'business',
  reports_advanced: 'business',
};
const TIERS = ['free', 'pro', 'business', 'enterprise'] as const;

const catalog = JSON.parse(
  readFileSync(new URL('../../../../../../scripts/ops/billing-catalog.json', import.meta.url), 'utf8'),
) as {
  items: { code: string; kind: string; rank: number; features?: string[]; limits?: Record<string, number> }[];
};
const matrix: MatrixPlan[] = catalog.items
  .filter((i) => i.kind === 'PLAN')
  .map((i) => ({ code: i.code, rank: i.rank, active: true, features: i.features ?? [], limits: i.limits ?? {} }));

describe('plan matrix', () => {
  it('[S13-02] the table covers every gated feature', () => {
    expect(Object.keys(REQUIRED_TIER).sort()).toEqual([...PlanFeature.options].sort());
    expect(matrix.map((p) => p.code)).toEqual([...TIERS]);
  });

  for (const [feature, tier] of Object.entries(REQUIRED_TIER) as [PlanFeature, 'pro' | 'business'][]) {
    it(`[S13-02] each gated feature returns PLAN_REQUIRED with the required tier: ${feature} → ${tier}`, () => {
      const from = TIERS.indexOf(tier);
      for (const [i, plan] of TIERS.entries()) {
        const gate = planGate(matrix, plan, feature);
        if (i >= from) expect(gate, `${plan} has ${feature}`).toEqual({ allowed: true });
        else expect(gate, `${plan} lacks ${feature}`).toEqual({ allowed: false, requiredPlan: tier });
      }
    });
  }

  it('[S13-02] an unknown plan has nothing; a retired plan is never the required one', () => {
    expect(planGate(matrix, 'none', 'website_api')).toEqual({ allowed: false, requiredPlan: 'pro' });
    const retired = matrix.map((p) => (p.code === 'pro' ? { ...p, active: false } : p));
    expect(planGate(retired, 'pro', 'website_api')).toEqual({ allowed: true });
    expect(planGate(retired, 'free', 'website_api')).toEqual({ allowed: false, requiredPlan: 'business' });
    expect(planGate([], 'free', 'ai_video')).toEqual({ allowed: false, requiredPlan: null });
  });
});

/** S13-F21: each plan's quotas (PLAN §11; absent: no limit) and the plan the first item over a limit needs. */
const QUOTAS: Record<(typeof TIERS)[number], Partial<Record<PlanQuota, [number, string | null]>>> = {
  free: {
    sites: [0, 'pro'],
    social_accounts: [0, 'pro'],
    crm_contacts: [100, 'pro'],
    studio_listings_month: [10, 'pro'],
  },
  pro: { sites: [1, 'business'], social_accounts: [2, 'business'] },
  business: { sites: [3, 'enterprise'], social_accounts: [6, 'enterprise'] },
  enterprise: {},
};

describe('plan quotas', () => {
  for (const plan of TIERS) {
    it(`[S13-F21] each quota refuses the first item over the plan limit (table from the catalog): ${plan}`, () => {
      for (const quota of PlanQuota.options) {
        const row = QUOTAS[plan][quota];
        expect(matrix.find((p) => p.code === plan)?.limits?.[quota], `${plan}/${quota}`).toBe(row?.[0]);
        if (!row) {
          expect(quotaGate(matrix, plan, quota, 1_000_000)).toEqual({ allowed: true });
          continue;
        }
        const [limit, requiredPlan] = row;
        expect(quotaGate(matrix, plan, quota, limit), `${plan}/${quota} at the limit`).toEqual({ allowed: true });
        expect(quotaGate(matrix, plan, quota, limit + 1), `${plan}/${quota} over`).toEqual({
          allowed: false,
          limit,
          requiredPlan,
        });
      }
    });
  }

  it('[S13-F21] add-on units raise the limit; the required plan is the cheapest one the items fit', () => {
    // Pro (1 site) with two extra websites: 3 sites fit, a 4th is refused (Business 3 + the same 2 add-ons fits).
    expect(quotaGate(matrix, 'pro', 'sites', 3, 2)).toEqual({ allowed: true });
    expect(quotaGate(matrix, 'pro', 'sites', 4, 2)).toEqual({ allowed: false, limit: 3, requiredPlan: 'business' });
    // 7 sites need Enterprise (no limit); a retired plan is never the required one.
    expect(quotaGate(matrix, 'pro', 'sites', 7)).toEqual({ allowed: false, limit: 1, requiredPlan: 'enterprise' });
    const retired = matrix.map((p) => (p.code === 'business' ? { ...p, active: false } : p));
    expect(quotaGate(retired, 'pro', 'sites', 2)).toEqual({ allowed: false, limit: 1, requiredPlan: 'enterprise' });
  });
});

describe('effectivePlan', () => {
  it('[S14-F1] maps only an unknown (or missing) plan code to Free; liveness is the SQL plan in force', () => {
    expect(effectivePlan('pro')).toBe('pro');
    expect(effectivePlan('unknown')).toBe(FREE_PLAN);
    expect(effectivePlan(null)).toBe(FREE_PLAN);
    expect(effectivePlan(undefined)).toBe(FREE_PLAN);
  });
});
