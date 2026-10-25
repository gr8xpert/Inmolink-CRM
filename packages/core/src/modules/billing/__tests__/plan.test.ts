import { readFileSync } from 'node:fs';
import { FREE_PLAN, PlanFeature } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { effectivePlan, type MatrixPlan, planGate } from '../plan';

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
) as { items: { code: string; kind: string; rank: number; features?: string[] }[] };
const matrix: MatrixPlan[] = catalog.items
  .filter((i) => i.kind === 'PLAN')
  .map((i) => ({ code: i.code, rank: i.rank, active: true, features: i.features ?? [] }));

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

describe('dunning grace', () => {
  const graceStart = new Date('2026-10-11T00:00:00Z');
  it('[S13-02] a past-due subscription keeps its plan within the grace, then falls back to Free', () => {
    const sub = { planCode: 'pro', status: 'PAST_DUE' as const };
    expect(effectivePlan({ ...sub, pastDueSince: new Date('2026-10-20T00:00:00Z') }, graceStart)).toBe('pro');
    expect(effectivePlan({ ...sub, pastDueSince: new Date('2026-10-01T00:00:00Z') }, graceStart)).toBe(FREE_PLAN);
    expect(effectivePlan({ planCode: 'pro', status: 'UNPAID' }, graceStart)).toBe(FREE_PLAN);
    expect(effectivePlan({ planCode: 'pro', status: 'ACTIVE', pastDueSince: null }, graceStart)).toBe('pro');
  });
});
