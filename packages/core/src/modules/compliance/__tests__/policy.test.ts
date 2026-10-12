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
});
