import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { assertVerified, can } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const USER = '01900000-0000-7000-8000-0000000000aa';

function ctxAs(actor: Ctx['actor'], over: { verified?: boolean; clientMode?: boolean } = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: over.verified ?? true, plan: 'test', locales: ['en'] },
    actor,
    locale: 'en',
    requestId: 'test',
    clientMode: over.clientMode ?? false,
  };
}

const as = (role: string, over?: { verified?: boolean; clientMode?: boolean }) =>
  ctxAs({ kind: 'user', userId: USER, role }, over);

describe('agencies policy', () => {
  it('lets a user read their own agency only', () => {
    expect(can(as('AGENT'), 'agencies.read')).toBe(true);
    expect(can(as('AGENT'), 'agencies.read', { agencyId: AGENCY })).toBe(true);
    expect(can(as('AGENT'), 'agencies.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'agencies.read')).toBe(false);
  });

  it('[S1-01] only agency and developer admins edit the company details, never in Client Mode', () => {
    expect(can(as('AGENCY_ADMIN'), 'agencies.updateDetails')).toBe(true);
    expect(can(as('DEVELOPER_ADMIN'), 'agencies.updateDetails')).toBe(true);
    for (const role of ['AGENT', 'DEVELOPER_AGENT', 'PARTNER']) {
      expect(can(as(role), 'agencies.updateDetails')).toBe(false);
    }
    expect(can(as('AGENCY_ADMIN', { clientMode: true }), 'agencies.updateDetails')).toBe(false);
    expect(can(as('AGENCY_ADMIN'), 'agencies.updateDetails', { agencyId: OTHER_AGENCY })).toBe(false);
  });

  it('[S1-01] new agency is PENDING and cannot set SHARED/PUBLIC or create API keys (VERIFICATION_REQUIRED)', () => {
    for (const action of ['listing.share', 'listing.publish', 'apiKey.create'] as const) {
      expect(() => assertVerified(as('AGENCY_ADMIN', { verified: false }), action)).toThrowError(
        expect.objectContaining({ code: 'VERIFICATION_REQUIRED', details: { action } }),
      );
      expect(() => assertVerified(as('AGENCY_ADMIN', { verified: true }), action)).not.toThrow();
    }
  });
});
