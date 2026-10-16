import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, can, MEDIA_ACTIONS, MEDIA_IMPERSONATION } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';

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

describe('media policy', () => {
  it('[S3-03] whoever lists properties manages their media; partners, systems and Client Mode do not', () => {
    for (const role of ['AGENCY_ADMIN', 'AGENT', 'DEVELOPER_ADMIN', 'DEVELOPER_AGENT']) {
      expect(can(ctxAs(role), 'media.manage'), role).toBe(true);
    }
    expect(can(ctxAs('PARTNER'), 'media.manage')).toBe(false);
    expect(can({ ...ctxAs('AGENT'), actor: { kind: 'system', reason: 'test' } }, 'media.manage')).toBe(false);
    expect(can(ctxAs('AGENT', { clientMode: true }), 'media.manage')).toBe(false);
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
  });

  it('[S3-F5] members open their agency listing documents; never in Client Mode or as impersonating staff', () => {
    for (const role of ['AGENCY_ADMIN', 'AGENT', 'DEVELOPER_ADMIN', 'DEVELOPER_AGENT'])
      expect(can(ctxAs(role), 'media.documents.read'), role).toBe(true);
    expect(can(ctxAs('AGENT', { clientMode: true }), 'media.documents.read')).toBe(false);
    expect(MEDIA_IMPERSONATION['media.documents.read']).toBe('forbidden');
  });

  it('[S3-F10] partner members never open listing documents (seller identities)', () => {
    expect(can(ctxAs('PARTNER'), 'media.documents.read')).toBe(false);
    expect(can(ctxAs('UNKNOWN_ROLE'), 'media.documents.read')).toBe(false);
  });

  it('[S4-F1] impersonating staff cannot upload or delete a listing document; members who list properties can', () => {
    const staff = (role: string): Ctx => {
      const ctx = ctxAs(role);
      return {
        ...ctx,
        actor: {
          ...(ctx.actor as { kind: 'user'; userId: string; role: string }),
          impersonatedBy: '01900000-0000-7000-8000-0000000000ff',
        },
      };
    };
    for (const role of ['AGENCY_ADMIN', 'AGENT', 'DEVELOPER_ADMIN', 'DEVELOPER_AGENT']) {
      expect(can(ctxAs(role), 'media.documents.manage'), role).toBe(true);
      expect(can(staff(role), 'media.documents.manage'), role).toBe(false);
    }
    expect(can(ctxAs('PARTNER'), 'media.documents.manage')).toBe(false);
    expect(can(ctxAs('AGENT', { clientMode: true }), 'media.documents.manage')).toBe(false);
    expect(MEDIA_IMPERSONATION['media.documents.manage']).toBe('forbidden');
    // photos stay a listing edit staff may make (S3-02, S4-F1 decision)
    expect(can(staff('AGENCY_ADMIN'), 'media.manage')).toBe(true);
  });

  it('[S3-03] impersonation rules cover every action', () => {
    expectImpersonationRules({
      actions: MEDIA_ACTIONS,
      rules: MEDIA_IMPERSONATION,
      can,
      admin: ctxAs('AGENCY_ADMIN'),
      staffUserId: '01900000-0000-7000-8000-0000000000ff',
    });
  });
});
