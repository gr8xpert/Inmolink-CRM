import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectClientModePinned } from '../../../testing/client-mode-pin';
import { CLIENT_MODE_ALLOWED, can, MATCHING_ACTIONS, MATCHING_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-0000000000aa';

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

const agent = ctxAs({ kind: 'user', userId: ME, role: 'AGENT' });

describe('matching policy', () => {
  it('[S5-06] members manage their own saved searches; partners and non-users cannot', () => {
    expect(can(agent, 'matching.savedSearches.manage')).toBe(true);
    expect(can(ctxAs({ kind: 'user', userId: ME, role: 'AGENCY_ADMIN' }), 'matching.savedSearches.manage')).toBe(true);
    expect(can(ctxAs({ kind: 'user', userId: ME, role: 'PARTNER' }), 'matching.savedSearches.manage')).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'matching.savedSearches.manage')).toBe(false);
  });

  it('[R2-02a] client profiles follow the contact rule: members read and write, partners and non-users cannot', () => {
    for (const action of ['matching.clientProfiles.read', 'matching.clientProfiles.write'] as const) {
      expect(can(agent, action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: ME, role: 'DEVELOPER_AGENT' }), action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: ME, role: 'PARTNER' }), action)).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
      expect(MATCHING_IMPERSONATION[action]).toBe('forbidden');
    }
  });

  it('[R2-02d] the review queue follows the contact rule: members read and review, partners and non-users cannot', () => {
    for (const action of ['matching.clientProfileMatches.read', 'matching.clientProfileMatches.review'] as const) {
      expect(can(agent, action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: ME, role: 'AGENCY_ADMIN' }), action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: ME, role: 'PARTNER' }), action)).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
      expect(MATCHING_IMPERSONATION[action]).toBe('forbidden');
    }
  });

  it('[S5-06] Client Mode and impersonating staff change nothing', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    expect(Object.keys(MATCHING_IMPERSONATION).sort()).toEqual([...MATCHING_ACTIONS].sort());
    for (const action of MATCHING_ACTIONS) {
      expect(can({ ...agent, clientMode: true }, action)).toBe(false);
      expect(can(ctxAs({ kind: 'user', userId: ME, role: 'AGENT', impersonatedBy: 'x' }), action)).toBe(false);
    }
  });

  it('[S13-F4] Client Mode allow-list pinned: nothing', () => {
    const admin = ctxAs({ kind: 'user', userId: ME, role: 'AGENCY_ADMIN' });
    expectClientModePinned({ actions: MATCHING_ACTIONS, allowed: CLIENT_MODE_ALLOWED, pinned: [], can, admin });
  });
});
