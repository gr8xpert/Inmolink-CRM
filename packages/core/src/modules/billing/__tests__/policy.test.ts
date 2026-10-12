import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { BILLING_ACTIONS, BILLING_IMPERSONATION, can } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';

function ctxAs(actor: Ctx['actor']): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor,
    locale: 'en',
    requestId: 'test',
    clientMode: false,
  };
}

const user = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role: 'AGENT' });

describe('billing policy', () => {
  it('lets a user read their own agency', () => {
    expect(can(user, 'billing.read')).toBe(true);
    expect(can(user, 'billing.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(user, 'billing.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'billing.read')).toBe(false);
  });

  it('[S1-09] billing changes: the agency’s admins only, never staff impersonating one', () => {
    const userId = '01900000-0000-7000-8000-0000000000aa';
    expect(can(ctxAs({ kind: 'user', userId, role: 'AGENCY_ADMIN' }), 'billing.manage')).toBe(true);
    expect(can(user, 'billing.manage')).toBe(false);
    const impersonated = ctxAs({
      kind: 'user',
      userId,
      role: 'AGENCY_ADMIN',
      impersonatedBy: '01900000-0000-7000-8000-0000000000bb',
    });
    expect(can(impersonated, 'billing.manage')).toBe(false);
    expect(can(impersonated, 'billing.read')).toBe(true);
  });

  it('[S1-09] every billing action declares whether staff impersonating an admin may do it; changes are refused', () => {
    expectImpersonationRules({
      actions: BILLING_ACTIONS,
      rules: BILLING_IMPERSONATION,
      can: (ctx, action) => can(ctx, action),
      admin: ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role: 'AGENCY_ADMIN' }),
      staffUserId: OTHER_AGENCY,
    });
    expect(BILLING_IMPERSONATION['billing.manage']).toBe('forbidden');
  });
});
