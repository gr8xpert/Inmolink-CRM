import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectClientModePinned } from '../../../testing/client-mode-pin';
import { CLIENT_MODE_ALLOWED, can, DOCUMENTS_ACTIONS } from '../policy';

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

const admin = ctxAs({ kind: 'user', userId: '01900000-0000-7000-8000-0000000000ab', role: 'AGENCY_ADMIN' });

describe('documents policy', () => {
  it('[S13-F4] members of the agency make and read documents; other agencies and non-users nothing', () => {
    for (const action of DOCUMENTS_ACTIONS) {
      expect(can(admin, action), action).toBe(true);
      expect(can(admin, action, { agencyId: OTHER_AGENCY }), action).toBe(false);
      expect(can(ctxAs({ kind: 'system', reason: 'test' }), action), action).toBe(false);
    }
  });

  it('[S13-F4] Client Mode allow-list pinned: brochures and portfolios (white-labelled) only', () => {
    expectClientModePinned({
      actions: DOCUMENTS_ACTIONS,
      allowed: CLIENT_MODE_ALLOWED,
      pinned: ['documents.create', 'documents.read'],
      can,
      admin,
    });
  });
});
