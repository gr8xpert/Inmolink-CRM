import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, IMPORTS_ACTIONS, IMPORTS_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';

function ctxAs(role: string, over: { clientMode?: boolean } = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: { kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role },
    locale: 'en',
    requestId: 'test',
    clientMode: over.clientMode ?? false,
  };
}

describe('imports policy', () => {
  it('[S6-01] admins manage connections; agents read and re-run; partners and other agencies get nothing', () => {
    for (const role of ['AGENCY_ADMIN', 'DEVELOPER_ADMIN']) {
      for (const action of IMPORTS_ACTIONS) expect(can(ctxAs(role), action, { agencyId: AGENCY }), role).toBe(true);
    }
    for (const role of ['AGENT', 'DEVELOPER_AGENT']) {
      expect(can(ctxAs(role), 'imports.read')).toBe(true);
      expect(can(ctxAs(role), 'imports.run')).toBe(true);
      expect(can(ctxAs(role), 'imports.manage')).toBe(false);
    }
    for (const action of IMPORTS_ACTIONS) {
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
      expect(can(ctxAs('AGENCY_ADMIN'), action, { agencyId: OTHER_AGENCY })).toBe(false);
    }
  });

  it('denies non-user actors', () => {
    const system = { ...ctxAs('AGENCY_ADMIN'), actor: { kind: 'system' as const, reason: 'test' } };
    for (const action of IMPORTS_ACTIONS) expect(can(system, action)).toBe(false);
  });

  it('Client Mode is read-only (PATTERNS §6): imports are internal, nothing is open', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of IMPORTS_ACTIONS) expect(can(ctxAs('AGENCY_ADMIN', { clientMode: true }), action)).toBe(false);
  });

  it('[S6-01] impersonating staff may read and re-run, never change a connection', () => {
    expectImpersonationRules({
      actions: IMPORTS_ACTIONS,
      rules: IMPORTS_IMPERSONATION,
      can: (ctx, action) => can(ctx, action),
      admin: ctxAs('AGENCY_ADMIN'),
      staffUserId: '01900000-0000-7000-8000-0000000000bb',
    });
  });
});
