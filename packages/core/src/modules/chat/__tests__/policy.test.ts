import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { CHAT_ACTIONS, CHAT_IMPERSONATION, CLIENT_MODE_ALLOWED, can } from '../policy';

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

describe('chat policy', () => {
  it('[S11-03] members read and write their own agency chat; other agencies and non-user actors are refused', () => {
    for (const action of CHAT_ACTIONS) {
      expect(can(user, action)).toBe(true);
      expect(can(user, action, { agencyId: AGENCY })).toBe(true);
      expect(can(user, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
    }
  });

  it('[S11-03] Client Mode opens nothing of chat', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of CHAT_ACTIONS) expect(can({ ...user, clientMode: true }, action)).toBe(false);
  });

  it('[S11-03] impersonating staff may read, never write', () => {
    expect(Object.keys(CHAT_IMPERSONATION).sort()).toEqual([...CHAT_ACTIONS].sort());
    const staff: Ctx = { ...user, actor: { kind: 'user', userId: user.requestId, role: 'AGENT', impersonatedBy: 'x' } };
    expect(can(staff, 'chat.read')).toBe(true);
    expect(can(staff, 'chat.write')).toBe(false);
  });
});
