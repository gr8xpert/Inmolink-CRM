import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { CLIENT_MODE_ALLOWED, can } from '../policy';

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

describe('presentations policy', () => {
  it('[S12-04] a member reads and makes their own agency selections', () => {
    for (const action of ['presentations.read', 'presentations.write'] as const) {
      expect(can(user, action)).toBe(true);
      expect(can(user, action, { agencyId: AGENCY })).toBe(true);
    }
  });

  it('[S12-04] other agencies and non-user actors are denied', () => {
    expect(can(user, 'presentations.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(user, 'presentations.write', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'presentations.read')).toBe(false);
  });

  it('[S12-04] Client Mode sees no selection (they name the client and what they did)', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    expect(can({ ...user, clientMode: true }, 'presentations.read')).toBe(false);
    expect(can({ ...user, clientMode: true }, 'presentations.write')).toBe(false);
  });
});
