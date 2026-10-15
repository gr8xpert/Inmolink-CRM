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

describe('quality policy', () => {
  it('lets a user read their own agency', () => {
    expect(can(user, 'quality.read')).toBe(true);
    expect(can(user, 'quality.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(user, 'quality.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'quality.read')).toBe(false);
  });

  it('Client Mode allows nothing: the score and its hints are internal', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    expect(can({ ...user, clientMode: true }, 'quality.read')).toBe(false);
  });
});
