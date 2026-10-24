import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, NOTIFICATIONS_ACTIONS, NOTIFICATIONS_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
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

const agent = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role: 'AGENT' });
const admin = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' });

describe('notifications policy', () => {
  it('[S11-04] every member reads, marks and configures their own notifications; non-user actors nothing', () => {
    for (const action of NOTIFICATIONS_ACTIONS) {
      expect(can(agent, action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: AGENCY, role: 'PARTNER' }), action)).toBe(true);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
      expect(can(ctxAs({ kind: 'apiKey', keyId: AGENCY, siteId: AGENCY, scopes: [] }), action)).toBe(false);
    }
  });

  it('[S11-04] nothing of notifications is open in Client Mode', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of NOTIFICATIONS_ACTIONS) expect(can({ ...agent, clientMode: true }, action)).toBe(false);
  });

  it('[S11-04] staff impersonating a member may read the feed, never mark it read nor change preferences', () => {
    expectImpersonationRules({
      actions: NOTIFICATIONS_ACTIONS,
      rules: NOTIFICATIONS_IMPERSONATION,
      can,
      admin,
      staffUserId: STAFF,
    });
  });
});
