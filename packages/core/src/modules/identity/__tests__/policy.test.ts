import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { can, loginDecision } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const SELF = '01900000-0000-7000-8000-0000000000aa';
const COLLEAGUE = '01900000-0000-7000-8000-0000000000bb';

function ctxAs(role: string, over: Partial<Ctx> = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: { kind: 'user', userId: SELF, role },
    locale: 'en',
    requestId: 'test',
    clientMode: false,
    ...over,
  };
}

describe('identity policy', () => {
  it('[S1-02] only AGENCY_ADMIN can invite or change roles', () => {
    expect(can(ctxAs('AGENCY_ADMIN'), 'identity.members.manage', { userId: COLLEAGUE, role: 'AGENT' })).toBe(true);
    for (const role of ['AGENT', 'DEVELOPER_AGENT', 'PARTNER']) {
      expect(can(ctxAs(role), 'identity.members.manage', { userId: COLLEAGUE, role: 'AGENT' })).toBe(false);
    }
    // Every member reads the team.
    expect(can(ctxAs('AGENT'), 'identity.members.read')).toBe(true);
  });

  it('[S1-02] an agent cannot elevate itself; nobody changes their own membership', () => {
    expect(can(ctxAs('AGENT'), 'identity.members.manage', { userId: SELF, role: 'AGENCY_ADMIN' })).toBe(false);
    expect(can(ctxAs('AGENCY_ADMIN'), 'identity.members.manage', { userId: SELF, role: 'AGENT' })).toBe(false);
  });

  it('[S1-02] admins manage their own role family, in their own agency, outside Client Mode', () => {
    const admin = ctxAs('AGENCY_ADMIN');
    expect(can(admin, 'identity.members.manage', { role: 'DEVELOPER_AGENT' })).toBe(false);
    expect(can(ctxAs('DEVELOPER_ADMIN'), 'identity.members.manage', { role: 'DEVELOPER_AGENT' })).toBe(true);
    expect(can(ctxAs('DEVELOPER_ADMIN'), 'identity.members.manage', { role: 'AGENT' })).toBe(false);
    expect(can(admin, 'identity.members.manage', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs('AGENCY_ADMIN', { clientMode: true }), 'identity.members.manage', { role: 'AGENT' })).toBe(false);
    const system = { ...admin, actor: { kind: 'system', reason: 'test' } } as Ctx;
    expect(can(system, 'identity.members.read')).toBe(false);
  });

  it('[S1-02] deactivated users cannot log in (same answer as a wrong password)', () => {
    const user = { status: 'ACTIVE', emailVerifiedAt: new Date() };
    expect(loginDecision(user, { deactivatedAt: null })).toBe('ok');
    expect(loginDecision(user, { deactivatedAt: new Date() })).toBe('invalid');
    expect(loginDecision(user, null)).toBe('ok');
  });
});
