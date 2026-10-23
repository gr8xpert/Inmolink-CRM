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

describe('exports policy', () => {
  it('lets a user read their own agency', () => {
    expect(can(user, 'exports.read')).toBe(true);
    expect(can(user, 'exports.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(user, 'exports.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'exports.read')).toBe(false);
  });

  it('[S9-01] members read portal setup, only admins manage it', () => {
    const admin = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' });
    expect(can(user, 'exports.manage')).toBe(false);
    expect(can(admin, 'exports.manage')).toBe(true);
    expect(can(admin, 'exports.manage', { agencyId: OTHER_AGENCY })).toBe(false);
  });

  it('[S9-01] portal setup is closed in Client Mode and to a staff member impersonating a member', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    expect(can({ ...user, clientMode: true }, 'exports.read')).toBe(false);
    const admin = ctxAs({
      kind: 'user',
      userId: '01900000-0000-7000-8000-0000000000ab',
      role: 'AGENCY_ADMIN',
      impersonatedBy: '01900000-0000-7000-8000-0000000000ac',
    });
    expect(can(admin, 'exports.read')).toBe(true);
    expect(can(admin, 'exports.manage')).toBe(false);
  });
});
