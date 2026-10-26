import { ONBOARDING_STEPS } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { expectClientModePinned } from '../../../testing/client-mode-pin';
import { CLIENT_MODE_ALLOWED, can, canStaff, ONBOARDING_ACTIONS, ROLE_STEPS, stepsForRole } from '../policy';

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
const staff = (role: StaffCtx['actor']['role']) =>
  ({ tx: {}, actor: { kind: 'staff', userId: 'u', role }, requestId: 't' }) as unknown as StaffCtx;

describe('onboarding policy', () => {
  it('[S13 review] Client Mode allow-list pinned: nothing', () => {
    expectClientModePinned({
      actions: ONBOARDING_ACTIONS,
      allowed: CLIENT_MODE_ALLOWED,
      pinned: [],
      can: (ctx, action) => can(ctx, action),
      admin: ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' }),
    });
  });

  it('lets a user read their own agency', () => {
    expect(can(user, 'onboarding.read')).toBe(true);
    expect(can(user, 'onboarding.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(user, 'onboarding.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'onboarding.read')).toBe(false);
  });

  it('[S13-04] Client Mode reaches nothing (the checklist is the agency business)', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    expect(can({ ...user, clientMode: true }, 'onboarding.read')).toBe(false);
  });

  it('[S13-04] role-based checklist: admins set up the agency, agents bring in and share listings', () => {
    expect(stepsForRole('AGENCY_ADMIN')).toEqual(ONBOARDING_STEPS);
    expect(stepsForRole('AGENT')).toEqual(['IMPORT_LISTINGS', 'SHARE_LISTING']);
    expect(stepsForRole('DEVELOPER_ADMIN')).toEqual([
      'VERIFY_AGENCY',
      'IMPORT_LISTINGS',
      'INVITE_TEAM',
      'SHARE_LISTING',
    ]);
    expect(stepsForRole('DEVELOPER_AGENT')).toEqual(['IMPORT_LISTINGS', 'SHARE_LISTING']);
    expect(stepsForRole('PARTNER')).toEqual([]);
    // unknown roles (and prototype keys) get nothing
    expect(stepsForRole('SUPER_ADMIN')).toEqual([]);
    expect(stepsForRole('constructor')).toEqual([]);
    for (const steps of Object.values(ROLE_STEPS)) for (const s of steps) expect(ONBOARDING_STEPS).toContain(s);
  });

  it('[S13-04] progress is visible to every staff role', () => {
    for (const role of ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const) {
      expect(canStaff(staff(role), 'staff.onboarding.read')).toBe(true);
    }
  });
});
