import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, PROPERTIES_ACTIONS, PROPERTIES_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const ME = '01900000-0000-7000-8000-0000000000aa';
const COLLEAGUE = '01900000-0000-7000-8000-0000000000bb';

function ctxAs(role: string, over: { clientMode?: boolean; impersonatedBy?: string } = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: { kind: 'user', userId: ME, role, ...(over.impersonatedBy ? { impersonatedBy: over.impersonatedBy } : {}) },
    locale: 'en',
    requestId: 'test',
    clientMode: over.clientMode ?? false,
  };
}

const mine = { agencyId: AGENCY, ownerUserId: ME };
const colleagues = { agencyId: AGENCY, ownerUserId: COLLEAGUE };
const foreign = { agencyId: OTHER_AGENCY, ownerUserId: COLLEAGUE };
const WRITES = ['listing.update', 'listing.delete', 'listing.restore', 'listing.publish'] as const;

describe('properties policy', () => {
  it('[S3-02] only the owner agency writes; agents edit only their own listings unless AGENCY_ADMIN', () => {
    for (const role of ['AGENT', 'DEVELOPER_AGENT']) {
      expect(can(ctxAs(role), 'listing.create')).toBe(true);
      for (const action of WRITES) {
        expect(can(ctxAs(role), action, mine), `${role} ${action} own`).toBe(true);
        expect(can(ctxAs(role), action, colleagues), `${role} ${action} colleague's`).toBe(false);
      }
      expect(can(ctxAs(role), 'listing.assign', mine)).toBe(false);
    }
    for (const role of ['AGENCY_ADMIN', 'DEVELOPER_ADMIN']) {
      for (const action of [...WRITES, 'listing.assign'] as const) {
        expect(can(ctxAs(role), action, colleagues), `${role} ${action}`).toBe(true);
        expect(can(ctxAs(role), action, foreign), `${role} ${action} other agency`).toBe(false);
      }
    }
    // Partners read, never list.
    expect(can(ctxAs('PARTNER'), 'listing.read')).toBe(true);
    expect(can(ctxAs('PARTNER'), 'listing.create')).toBe(false);
    expect(can(ctxAs('PARTNER'), 'listing.update', { agencyId: AGENCY, ownerUserId: ME })).toBe(false);
  });

  it('[S3-02] non-user actors are refused', () => {
    const system = { ...ctxAs('AGENCY_ADMIN'), actor: { kind: 'system' as const, reason: 'test' } };
    for (const action of PROPERTIES_ACTIONS) expect(can(system, action, mine)).toBe(false);
  });

  it('Client Mode is read-only (PATTERNS §6): only read actions are allowed, and they still work', () => {
    for (const action of CLIENT_MODE_ALLOWED) expect(action).toMatch(/\.(read|list|get)$/);
    expect(can(ctxAs('AGENCY_ADMIN', { clientMode: true }), 'listing.read')).toBe(true);
    for (const action of PROPERTIES_ACTIONS.filter((a) => !CLIENT_MODE_ALLOWED.has(a))) {
      expect(can(ctxAs('AGENCY_ADMIN', { clientMode: true }), action, mine), action).toBe(false);
    }
  });

  it('[S3-02] staff impersonating a member read, create and fix listings; never delete, publish or reassign', () => {
    expectImpersonationRules({
      actions: PROPERTIES_ACTIONS,
      rules: PROPERTIES_IMPERSONATION,
      can: (ctx, action) => can(ctx, action, mine),
      admin: ctxAs('AGENCY_ADMIN'),
      staffUserId: COLLEAGUE,
    });
  });
});
