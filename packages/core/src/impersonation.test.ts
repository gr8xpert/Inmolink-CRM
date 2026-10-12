import { describe, expect, it } from 'vitest';
import type { Ctx } from './context';
import { deniedByImpersonation, type ImpersonationRules, impersonatorOf } from './impersonation';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const USER = '01900000-0000-7000-8000-0000000000aa';
const STAFF = '01900000-0000-7000-8000-0000000000bb';

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

describe('impersonation rules', () => {
  it('[S1-09] impersonated sessions get only what a module declares allowed; anything else is denied', () => {
    const admin = ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN' });
    const impersonated = ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN', impersonatedBy: STAFF });
    expect(impersonatorOf(admin)).toBeNull();
    expect(impersonatorOf(impersonated)).toBe(STAFF);
    expect(impersonatorOf(ctxAs({ kind: 'system', reason: 'test' }))).toBeNull();
    const rules: ImpersonationRules<'a' | 'b'> = { a: 'allowed', b: 'forbidden' };
    expect(deniedByImpersonation(admin, rules, 'b')).toBe(false);
    expect(deniedByImpersonation(impersonated, rules, 'a')).toBe(false);
    expect(deniedByImpersonation(impersonated, rules, 'b')).toBe(true);
    // A map that lost an entry (only possible by casting) fails closed.
    expect(deniedByImpersonation(impersonated, {} as typeof rules, 'a')).toBe(true);
  });
});
