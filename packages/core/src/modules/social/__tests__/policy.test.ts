import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, SOCIAL_ACTIONS, SOCIAL_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';

function ctxAs(actor: Ctx['actor'], over: Partial<Ctx> = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor,
    locale: 'en',
    requestId: 'test',
    clientMode: false,
    ...over,
  };
}

const agent = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role: 'AGENT' });
const admin = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' });

describe('social policy (S12-07)', () => {
  it('[S12-07] members read and post; admins connect accounts; other agencies and non-users nothing', () => {
    expect(can(agent, 'social.read')).toBe(true);
    expect(can(agent, 'social.post')).toBe(true);
    expect(can(agent, 'social.manage')).toBe(false);
    expect(can(admin, 'social.manage')).toBe(true);
    expect(can(agent, 'social.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'social.read')).toBe(false);
  });

  it('[S12-07] nothing in Client Mode; staff impersonating may only read', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of SOCIAL_ACTIONS) expect(can({ ...admin, clientMode: true }, action)).toBe(false);
    expectImpersonationRules({
      actions: SOCIAL_ACTIONS,
      rules: SOCIAL_IMPERSONATION,
      can: (ctx, action) => can(ctx, action),
      admin,
      staffUserId: '01900000-0000-7000-8000-0000000000ff',
    });
  });
});
