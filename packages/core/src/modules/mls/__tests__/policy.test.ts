import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, MLS_ACTIONS, MLS_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';

function ctxAs(role: string, over: Partial<Ctx> = {}, actor?: Ctx['actor']): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: actor ?? { kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role },
    locale: 'en',
    requestId: 'test',
    clientMode: false,
    ...over,
  };
}

const agent = ctxAs('AGENT');

describe('mls policy', () => {
  it('[S11-01] members read and register clients of their own agency; partners, other agencies and systems do not', () => {
    for (const action of MLS_ACTIONS) {
      expect(can(agent, action)).toBe(true);
      expect(can(ctxAs('AGENCY_ADMIN'), action, { agencyId: AGENCY })).toBe(true);
      expect(can(agent, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
      expect(can(ctxAs('AGENT', {}, { kind: 'system', reason: 'test' }), action)).toBe(false);
    }
  });

  it('[S11-01] an unverified agency reads its registrations but cannot register on the network', () => {
    const unverified = ctxAs('AGENT', { tenant: { agencyId: AGENCY, verified: false, plan: 'test', locales: ['en'] } });
    expect(can(unverified, 'mls.registrations.read')).toBe(true);
    expect(can(unverified, 'mls.registrations.write')).toBe(false);
  });

  it('[S11-01] nothing is open in Client Mode: registrations name clients and partners', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of MLS_ACTIONS) expect(can({ ...agent, clientMode: true }, action)).toBe(false);
  });

  it('[S11-01] staff impersonating a member may look, never register', () => {
    expectImpersonationRules({
      actions: MLS_ACTIONS,
      rules: MLS_IMPERSONATION,
      can,
      admin: ctxAs('AGENCY_ADMIN'),
      staffUserId: '01900000-0000-7000-8000-0000000000bb',
    });
    expect(MLS_IMPERSONATION['mls.registrations.write']).toBe('forbidden');
  });

  it('[S11-02] viewing requests: members read and answer; unverified agencies only read; impersonators never bind terms', () => {
    const unverified = ctxAs('AGENT', { tenant: { agencyId: AGENCY, verified: false, plan: 'test', locales: ['en'] } });
    expect(can(agent, 'mls.viewings.read')).toBe(true);
    expect(can(agent, 'mls.viewings.write')).toBe(true);
    expect(can(unverified, 'mls.viewings.read')).toBe(true);
    expect(can(unverified, 'mls.viewings.write')).toBe(false);
    expect(can(ctxAs('PARTNER'), 'mls.viewings.read')).toBe(false);
    expect(can({ ...agent, clientMode: true }, 'mls.viewings.read')).toBe(false);
    expect(MLS_IMPERSONATION['mls.viewings.write']).toBe('forbidden');
  });
});
