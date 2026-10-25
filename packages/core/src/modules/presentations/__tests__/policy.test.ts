import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, PRESENTATIONS_ACTIONS, PRESENTATIONS_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const STAFF = '01900000-0000-7000-8000-0000000000bb';

function ctxAs(role: string, actor?: Ctx['actor']): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: actor ?? { kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role },
    locale: 'en',
    requestId: 'test',
    clientMode: false,
  };
}

const agent = ctxAs('AGENT');

describe('presentations policy', () => {
  it('[S12-04] the members who work clients read and make their own agency selections; partners do not', () => {
    for (const action of PRESENTATIONS_ACTIONS) {
      for (const role of ['AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT']) {
        expect(can(ctxAs(role), action), `${role} ${action}`).toBe(true);
      }
      expect(can(agent, action, { agencyId: AGENCY })).toBe(true);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
    }
  });

  it('[S12-04] other agencies and non-user actors are denied', () => {
    expect(can(agent, 'presentations.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(agent, 'presentations.write', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs('AGENT', { kind: 'system', reason: 'test' }), 'presentations.read')).toBe(false);
  });

  it('[S12-04] Client Mode sees no selection (they name the client and what they did)', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    expect(can({ ...agent, clientMode: true }, 'presentations.read')).toBe(false);
    expect(can({ ...agent, clientMode: true }, 'presentations.write')).toBe(false);
  });

  it('[S12-04] staff impersonating may look at selections, never make one or mint a link', () => {
    expect(PRESENTATIONS_IMPERSONATION['presentations.read']).toBe('allowed');
    expect(PRESENTATIONS_IMPERSONATION['presentations.write']).toBe('forbidden');
    expectImpersonationRules({
      actions: PRESENTATIONS_ACTIONS,
      rules: PRESENTATIONS_IMPERSONATION,
      can,
      admin: ctxAs('AGENCY_ADMIN'),
      staffUserId: STAFF,
    });
  });
});
