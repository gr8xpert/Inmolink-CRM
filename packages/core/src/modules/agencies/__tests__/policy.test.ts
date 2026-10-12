import { describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx, StaffRole } from '../../../context';
import { assertVerified, can, canStaff } from '../policy';

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

  it('[S1-06] admins edit the profile and settings, never in Client Mode; staff impersonating one only the profile', () => {
    for (const action of ['agencies.profile.update', 'agencies.settings.update'] as const) {
      expect(can(as('AGENCY_ADMIN'), action)).toBe(true);
      expect(can(as('DEVELOPER_ADMIN'), action)).toBe(true);
      for (const role of ['AGENT', 'DEVELOPER_AGENT', 'PARTNER']) expect(can(as(role), action)).toBe(false);
      expect(can(as('AGENCY_ADMIN', { clientMode: true }), action)).toBe(false);
      expect(can(as('AGENCY_ADMIN'), action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
    }
    const impersonated = ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN', impersonatedBy: USER });
    expect(can(impersonated, 'agencies.profile.update')).toBe(true);
    expect(can(impersonated, 'agencies.settings.update')).toBe(false);
  });

  it('[S1-06] members read settings and the default commission, never in Client Mode', () => {
    for (const action of ['agencies.settings.read', 'agencies.commission.read'] as const) {
      expect(can(as('AGENT'), action)).toBe(true);
      expect(can(as('AGENCY_ADMIN'), action)).toBe(true);
      expect(can(as('AGENT', { clientMode: true }), action)).toBe(false);
      expect(can(as('AGENT'), action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
    }
  });

  it('[S1-03] verification documents and submission are for admins only, never in Client Mode', () => {
    for (const action of ['agencies.verification.read', 'agencies.verification.manage'] as const) {
      expect(can(as('AGENCY_ADMIN'), action)).toBe(true);
      expect(can(as('DEVELOPER_ADMIN'), action)).toBe(true);
      expect(can(as('AGENT'), action)).toBe(false);
      expect(can(as('AGENCY_ADMIN', { clientMode: true }), action)).toBe(false);
      expect(can(as('AGENCY_ADMIN'), action, { agencyId: OTHER_AGENCY })).toBe(false);
    }
  });

  it('[S1-07] admins add and manage preferred agencies, members read the list; staff impersonating may not add', () => {
    for (const action of ['agencies.preferred.add', 'agencies.preferred.manage'] as const) {
      expect(can(as('AGENCY_ADMIN'), action)).toBe(true);
      expect(can(as('DEVELOPER_ADMIN'), action)).toBe(true);
      for (const role of ['AGENT', 'DEVELOPER_AGENT', 'PARTNER']) expect(can(as(role), action)).toBe(false);
      expect(can(as('AGENCY_ADMIN', { clientMode: true }), action)).toBe(false);
      expect(can(as('AGENCY_ADMIN'), action, { agencyId: OTHER_AGENCY })).toBe(false);
    }
    for (const action of ['agencies.preferred.read', 'agencies.directory.search'] as const) {
      expect(can(as('AGENT'), action)).toBe(true);
      expect(can(as('AGENT', { clientMode: true }), action)).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
    }
    const impersonated = ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN', impersonatedBy: USER });
    expect(can(impersonated, 'agencies.preferred.add')).toBe(false);
    expect(can(impersonated, 'agencies.preferred.manage')).toBe(true);
    for (const action of ['preferredAgency.add', 'directory.search'] as const) {
      expect(() => assertVerified(as('AGENCY_ADMIN', { verified: false }), action)).toThrowError(
        expect.objectContaining({ code: 'VERIFICATION_REQUIRED' }),
      );
    }
  });

  it('[S1-03] only super admins and support staff read and decide verification', () => {
    const staff = (role: StaffRole): StaffCtx => ({
      tx: {} as StaffCtx['tx'],
      actor: { kind: 'staff', userId: USER, role },
      locale: 'en',
      requestId: 'test',
    });
    for (const action of ['staff.verification.read', 'staff.verification.decide'] as const) {
      expect(canStaff(staff('SUPER_ADMIN'), action)).toBe(true);
      expect(canStaff(staff('STAFF_SUPPORT'), action)).toBe(true);
      expect(canStaff(staff('STAFF_DATA_OPS'), action)).toBe(false);
    }
  });
});
