import { describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { CLIENT_MODE_ALLOWED, can, canStaff, DEDUPE_ACTIONS } from '../policy';

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

const as = (role: string) => ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role } as never);
const agent = as('AGENT');
const admin = as('AGENCY_ADMIN');
const staff = (role: string) =>
  ({
    tx: {},
    actor: { kind: 'staff', userId: '01900000-0000-7000-8000-0000000000bb', role },
    requestId: 'x',
  }) as never as StaffCtx;

describe('dedupe policy', () => {
  it('lets a stock member read their own agency', () => {
    expect(can(agent, 'dedupe.read')).toBe(true);
    expect(can(agent, 'dedupe.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(agent, 'dedupe.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'dedupe.read')).toBe(false);
  });

  it('Client Mode is read-only (PATTERNS §6) — and the duplicate views are internal: nothing is allowed', () => {
    for (const action of CLIENT_MODE_ALLOWED) expect(action).toMatch(/\.(read|list|get)$/);
    for (const action of DEDUPE_ACTIONS) expect(can({ ...admin, clientMode: true }, action)).toBe(false);
  });

  it('[R2-03b] agency admins decide pairs and dispute; agents read; partners nothing; staff read, data ops resolve', () => {
    expect(can(admin, 'dedupe.review')).toBe(true);
    expect(can(admin, 'dedupe.dispute')).toBe(true);
    expect(can(agent, 'dedupe.review')).toBe(false);
    expect(can(agent, 'dedupe.dispute')).toBe(false);
    for (const action of DEDUPE_ACTIONS) expect(can(as('PARTNER'), action)).toBe(false);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.dedupe.read')).toBe(true);
    expect(canStaff(staff('STAFF_SUPPORT'), 'staff.dedupe.resolve')).toBe(false);
    expect(canStaff(staff('STAFF_DATA_OPS'), 'staff.dedupe.resolve')).toBe(true);
    expect(canStaff(staff('SUPER_ADMIN'), 'staff.dedupe.resolve')).toBe(true);
  });
});
