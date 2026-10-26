import { describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { expectClientModePinned } from '../../../testing/client-mode-pin';
import { CLIENT_MODE_ALLOWED, can, canStaff, SUPPORT_ACTIONS } from '../policy';

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
const staff = (role: StaffCtx['actor']['role']): StaffCtx => ({
  tx: {} as StaffCtx['tx'],
  actor: { kind: 'staff', userId: '01900000-0000-7000-8000-0000000000bb', role },
  locale: 'en',
  requestId: 'test',
});

describe('support policy', () => {
  it('[S13 review] Client Mode allow-list pinned: nothing', () => {
    expectClientModePinned({
      actions: SUPPORT_ACTIONS,
      allowed: CLIENT_MODE_ALLOWED,
      pinned: [],
      can: (ctx, action) => can(ctx, action),
      admin: ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' }),
    });
  });

  it('[S13-05] every member reads and writes their own agency’s tickets', () => {
    for (const action of ['support.read', 'support.write'] as const) {
      expect(can(user, action)).toBe(true);
      expect(can(user, action, { agencyId: AGENCY })).toBe(true);
    }
  });

  it('[S13-05] denies other agencies and non-user actors', () => {
    expect(can(user, 'support.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'support.read')).toBe(false);
  });

  it('[S13-05] Client Mode reaches no support action (PATTERNS §6: never a write, and tickets are not for clients)', () => {
    for (const action of CLIENT_MODE_ALLOWED) expect(action).toMatch(/\.(read|list|get)$/);
    expect(can({ ...user, clientMode: true }, 'support.read')).toBe(false);
    expect(can({ ...user, clientMode: true }, 'support.write')).toBe(false);
  });

  it('[S13-05] every staff role reads the queue; only support staff and super admins reply and triage', () => {
    for (const role of ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const) {
      expect(canStaff(staff(role), 'staff.support.read')).toBe(true);
    }
    expect(canStaff(staff('SUPER_ADMIN'), 'staff.support.write')).toBe(true);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.support.write')).toBe(true);
    expect(canStaff(staff('STAFF_DATA_OPS'), 'staff.support.write')).toBe(false);
  });
});
