import type { StaffRole } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import { canStaff } from '../policy';

const staff = (role: StaffRole): StaffCtx => ({
  tx: {} as StaffCtx['tx'],
  actor: { kind: 'staff', userId: '01900000-0000-7000-8000-0000000000aa', role },
  locale: 'en',
  requestId: 'test',
});

describe('admin policy (S13-03)', () => {
  it('[S13-03] every staff role reads; data ops and super admins run operations; super admins set flags', () => {
    for (const role of ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const) {
      expect(canStaff(staff(role), 'staff.admin.read')).toBe(true);
    }
    expect(canStaff(staff('SUPER_ADMIN'), 'staff.admin.runOperation')).toBe(true);
    expect(canStaff(staff('STAFF_DATA_OPS'), 'staff.admin.runOperation')).toBe(true);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.admin.runOperation')).toBe(false);
    expect(canStaff(staff('SUPER_ADMIN'), 'staff.admin.setFlag')).toBe(true);
    expect(canStaff(staff('STAFF_DATA_OPS'), 'staff.admin.setFlag')).toBe(false);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.admin.setFlag')).toBe(false);
  });
});
