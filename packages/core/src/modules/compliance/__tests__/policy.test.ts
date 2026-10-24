import { describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx, StaffRole } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { COMPLIANCE_ACTIONS, COMPLIANCE_IMPERSONATION, can, canStaff } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const USER = '01900000-0000-7000-8000-0000000000aa';

function ctxAs(actor: Ctx['actor'], clientMode = false): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor,
    locale: 'en',
    requestId: 'test',
    clientMode,
  };
}

const admin = ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN' });

describe('compliance policy', () => {
  it('[S1-08] the audit log is read by the agency’s own admins (also while impersonated)', () => {
    expect(can(admin, 'compliance.auditLog.read')).toBe(true);
    expect(can(ctxAs({ kind: 'user', userId: USER, role: 'DEVELOPER_ADMIN' }), 'compliance.auditLog.read')).toBe(true);
    expect(
      can(
        ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN', impersonatedBy: OTHER_AGENCY }),
        'compliance.auditLog.read',
      ),
    ).toBe(true);
  });

  it('[S1-08] other roles, Client Mode, other agencies and non-user actors cannot read it', () => {
    expect(can(ctxAs({ kind: 'user', userId: USER, role: 'AGENT' }), 'compliance.auditLog.read')).toBe(false);
    expect(can(ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN' }, true), 'compliance.auditLog.read')).toBe(
      false,
    );
    expect(can(admin, 'compliance.auditLog.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'compliance.auditLog.read')).toBe(false);
  });

  it('[S1-09] the cross-agency viewer is for super admins and support, not data ops', () => {
    const staff = (role: StaffRole): StaffCtx => ({
      tx: {} as StaffCtx['tx'],
      actor: { kind: 'staff', userId: USER, role },
      locale: 'en',
      requestId: 'test',
    });
    expect(canStaff(staff('SUPER_ADMIN'), 'staff.auditLog.read')).toBe(true);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.auditLog.read')).toBe(true);
    expect(canStaff(staff('STAFF_DATA_OPS'), 'staff.auditLog.read')).toBe(false);
  });

  it('[S1-09] every compliance action declares whether staff impersonating an admin may do it', () => {
    expectImpersonationRules({
      actions: COMPLIANCE_ACTIONS,
      rules: COMPLIANCE_IMPERSONATION,
      can: (ctx, action) => can(ctx, action),
      admin,
      staffUserId: OTHER_AGENCY,
    });
  });

  it('[S10-08] data exports are for the agency’s own admins only — never other roles, Client Mode or other agencies', () => {
    const actions = [
      'compliance.dataExport.create',
      'compliance.dataExport.read',
      'compliance.dataExport.download',
    ] as const;
    for (const action of actions) {
      expect(can(admin, action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: USER, role: 'DEVELOPER_ADMIN' }), action)).toBe(true);
      expect(can(ctxAs({ kind: 'user', userId: USER, role: 'AGENT' }), action)).toBe(false);
      expect(can(ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN' }, true), action)).toBe(false);
      expect(can(admin, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action)).toBe(false);
    }
  });

  it('[S10-08] staff impersonating an admin may see exports but never export or download the agency’s data', () => {
    const impersonated = ctxAs({ kind: 'user', userId: USER, role: 'AGENCY_ADMIN', impersonatedBy: OTHER_AGENCY });
    expect(can(impersonated, 'compliance.dataExport.read')).toBe(true);
    expect(can(impersonated, 'compliance.dataExport.create')).toBe(false);
    expect(can(impersonated, 'compliance.dataExport.download')).toBe(false);
  });
});
