import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectClientModePinned } from '../../../testing/client-mode-pin';
import { AI_FEATURES_ACTIONS, CLIENT_MODE_ALLOWED, can } from '../policy';

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

describe('ai-features policy', () => {
  it('lets a user read their own agency', () => {
    expect(can(user, 'aiFeatures.read')).toBe(true);
    expect(can(user, 'aiFeatures.read', { agencyId: AGENCY })).toBe(true);
  });

  it('denies other agencies and non-user actors', () => {
    expect(can(user, 'aiFeatures.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs({ kind: 'system', reason: 'test' }), 'aiFeatures.read')).toBe(false);
  });

  it('Client Mode is read-only (PATTERNS §6): only read actions are allowed, and they still work', () => {
    for (const action of CLIENT_MODE_ALLOWED) expect(action).toMatch(/\.(read|list|get)$/);
    expect(can({ ...user, clientMode: true }, 'aiFeatures.read')).toBe(true);
  });

  it('[S12-02] Listing Studio: listing writers of the agency; not partners, Client Mode or impersonating staff', () => {
    expect(can(user, 'aiFeatures.listingStudio')).toBe(true);
    expect(
      can(ctxAs({ kind: 'user', userId: user.tenant.agencyId, role: 'AGENCY_ADMIN' }), 'aiFeatures.listingStudio'),
    ).toBe(true);
    expect(
      can(
        ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000bb', role: 'PARTNER' }),
        'aiFeatures.listingStudio',
      ),
    ).toBe(false);
    expect(can({ ...user, clientMode: true }, 'aiFeatures.listingStudio')).toBe(false);
    expect(
      can(
        ctxAs({
          kind: 'user',
          userId: '01900000-0000-7000-8000-0000000000aa',
          role: 'AGENT',
          impersonatedBy: OTHER_AGENCY,
        }),
        'aiFeatures.listingStudio',
      ),
    ).toBe(false);
    expect(can(user, 'aiFeatures.listingStudio', { agencyId: OTHER_AGENCY })).toBe(false);
  });

  it('[S13-F4] Client Mode allow-list pinned: the read only, never the Listing Studio', () => {
    expectClientModePinned({
      actions: AI_FEATURES_ACTIONS,
      allowed: CLIENT_MODE_ALLOWED,
      pinned: ['aiFeatures.read'],
      can,
      admin: ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' }),
    });
  });
});
