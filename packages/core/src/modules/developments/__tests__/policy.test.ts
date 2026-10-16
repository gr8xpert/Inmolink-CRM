import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, DEVELOPMENTS_ACTIONS, DEVELOPMENTS_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const STAFF = '01900000-0000-7000-8000-0000000000bb';
const mine = { agencyId: AGENCY };
const theirs = { agencyId: OTHER_AGENCY };

function ctxAs(role: string, over: { clientMode?: boolean } = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: { kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role },
    locale: 'en',
    requestId: 'test',
    clientMode: over.clientMode ?? false,
  };
}

describe('developments policy', () => {
  it('[S4-02] only the owner agency writes; agents maintain units and prices, admins share, delete and approve', () => {
    const admin = ctxAs('DEVELOPER_ADMIN');
    const agent = ctxAs('DEVELOPER_AGENT');
    for (const action of DEVELOPMENTS_ACTIONS) expect(can(admin, action, mine)).toBe(true);
    for (const action of DEVELOPMENTS_ACTIONS.filter((a) => a !== 'development.read')) {
      expect(can(admin, action, theirs)).toBe(false);
    }
    expect(can(agent, 'development.update', mine)).toBe(true);
    expect(can(agent, 'priceList.read', mine)).toBe(true);
    for (const action of [
      'development.delete',
      'development.share',
      'development.commission',
      'priceList.approve',
    ] as const) {
      expect(can(agent, action, mine)).toBe(false);
    }
    expect(can(ctxAs('PARTNER'), 'development.update', mine)).toBe(false);
    expect(can(ctxAs('PARTNER'), 'development.read', theirs)).toBe(true);
  });

  it('denies non-user actors', () => {
    const system = { ...ctxAs('AGENCY_ADMIN'), actor: { kind: 'system', reason: 'test' } } as Ctx;
    expect(can(system, 'development.read')).toBe(false);
  });

  it('Client Mode is read-only (PATTERNS §6): only read actions are allowed, and they still work', () => {
    for (const action of CLIENT_MODE_ALLOWED) expect(action).toMatch(/\.(read|list|get)$/);
    expect(can(ctxAs('AGENCY_ADMIN', { clientMode: true }), 'development.read')).toBe(true);
    expect(can(ctxAs('AGENCY_ADMIN', { clientMode: true }), 'development.update', mine)).toBe(false);
  });

  it('[S4-02] staff impersonating a member read and fix data; never delete, share, change commission or approve', () => {
    expectImpersonationRules({
      actions: DEVELOPMENTS_ACTIONS,
      rules: DEVELOPMENTS_IMPERSONATION,
      can: (ctx, action) => can(ctx, action, mine),
      admin: ctxAs('AGENCY_ADMIN'),
      staffUserId: STAFF,
    });
  });
});
