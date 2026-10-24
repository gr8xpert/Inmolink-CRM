import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { CLIENT_MODE_ALLOWED, can, NETWORK_ACTIONS, NETWORK_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const ME = '01900000-0000-7000-8000-0000000000aa';
const COLLEAGUE = '01900000-0000-7000-8000-0000000000bb';

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
const admin = ctxAs({ kind: 'user', userId: ME, role: 'AGENCY_ADMIN' });

describe('network policy', () => {
  it('[S11-05] members read the board, post, reply and manage their subscriptions; partners and non-users cannot', () => {
    for (const action of ['network.posts.read', 'network.posts.write', 'network.subscriptions.manage'] as const) {
      expect(can(agent, action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: ME, role: 'PARTNER' }), action)).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
    }
  });

  it('[S11-05] a post is closed by its author or an admin of its agency', () => {
    expect(can(agent, 'network.posts.close', { agencyId: AGENCY, authorUserId: ME })).toBe(true);
    expect(can(agent, 'network.posts.close', { agencyId: AGENCY, authorUserId: COLLEAGUE })).toBe(false);
    expect(can(admin, 'network.posts.close', { agencyId: AGENCY, authorUserId: COLLEAGUE })).toBe(true);
    expect(can(admin, 'network.posts.close', { agencyId: OTHER_AGENCY, authorUserId: ME })).toBe(false);
    expect(can(admin, 'network.posts.close')).toBe(false);
  });

  it('[S11-05] only admins join a reply thread of the agency on their own', () => {
    expect(can(admin, 'network.threads.join')).toBe(true);
    expect(can(agent, 'network.threads.join')).toBe(false);
  });

  it('[S11-05] Client Mode opens nothing of the board', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of NETWORK_ACTIONS) {
      expect(can({ ...admin, clientMode: true }, action, { agencyId: AGENCY, authorUserId: ME })).toBe(false);
    }
  });

  it('[S11-05] impersonating staff may read, never post, reply, close or subscribe', () => {
    expect(Object.keys(NETWORK_IMPERSONATION).sort()).toEqual([...NETWORK_ACTIONS].sort());
    const staff = ctxAs({ kind: 'user', userId: ME, role: 'AGENCY_ADMIN', impersonatedBy: 'x' });
    expect(can(staff, 'network.posts.read')).toBe(true);
    expect(can(staff, 'network.posts.write')).toBe(false);
    expect(can(staff, 'network.posts.close', { agencyId: AGENCY, authorUserId: ME })).toBe(false);
    expect(can(staff, 'network.subscriptions.manage')).toBe(false);
  });
});
