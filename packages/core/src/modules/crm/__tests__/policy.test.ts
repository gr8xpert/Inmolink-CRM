import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { expectImpersonationRules } from '../../../testing/impersonation-rules';
import { CLIENT_MODE_ALLOWED, CRM_ACTIONS, CRM_IMPERSONATION, can } from '../policy';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const OTHER_AGENCY = '01900000-0000-7000-8000-000000000002';
const STAFF = '01900000-0000-7000-8000-0000000000bb';

function ctxAs(role: string, actor?: Ctx['actor']): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: actor ?? { kind: 'user', userId: '01900000-0000-7000-8000-0000000000aa', role },
    locale: 'en',
    requestId: 'test',
    clientMode: false,
  };
}

const agent = ctxAs('AGENT');
const admin = ctxAs('AGENCY_ADMIN');

describe('crm policy', () => {
  it('[S10-01] members read, write and merge their own agency’s contacts; only admins import', () => {
    for (const action of ['crm.contacts.read', 'crm.contacts.write', 'crm.contacts.merge'] as const) {
      expect(can(agent, action)).toBe(true);
      expect(can(agent, action, { agencyId: AGENCY })).toBe(true);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
    }
    expect(can(agent, 'crm.contacts.import')).toBe(false);
    expect(can(admin, 'crm.contacts.import')).toBe(true);
  });

  it('[S11-F12] only agency admins erase a contact, of their own agency, never impersonating staff', () => {
    expect(can(agent, 'crm.contacts.erase')).toBe(false);
    expect(can(ctxAs('PARTNER'), 'crm.contacts.erase')).toBe(false);
    expect(can(admin, 'crm.contacts.erase', { agencyId: AGENCY })).toBe(true);
    expect(can(admin, 'crm.contacts.erase', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(CRM_IMPERSONATION['crm.contacts.erase']).toBe('forbidden');
  });

  it('[S10-02] members read and work their agency’s leads; only admins set the assignment rule', () => {
    for (const action of ['crm.leads.read', 'crm.leads.write'] as const) {
      expect(can(agent, action, { agencyId: AGENCY })).toBe(true);
      expect(can(agent, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
    }
    expect(can(agent, 'crm.leads.routing')).toBe(false);
    expect(can(admin, 'crm.leads.routing')).toBe(true);
  });

  it('[S10-04] members read the timeline and log activities of their own agency; partners do not', () => {
    for (const action of ['crm.activities.read', 'crm.activities.write'] as const) {
      expect(can(agent, action, { agencyId: AGENCY })).toBe(true);
      expect(can(agent, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
    }
  });

  it('[S10-06] members use their agency’s calendar and their own feed; partners and staff impersonating do not write', () => {
    for (const action of ['crm.calendar.read', 'crm.calendar.write', 'crm.calendar.feed'] as const) {
      expect(can(agent, action, { agencyId: AGENCY })).toBe(true);
      expect(can(agent, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
    }
    expect(CRM_IMPERSONATION['crm.calendar.read']).toBe('allowed');
    expect(CRM_IMPERSONATION['crm.calendar.write']).toBe('forbidden');
    expect(CRM_IMPERSONATION['crm.calendar.feed']).toBe('forbidden');
  });

  it('[S10-07] members work their agency’s acquisition board; confidential notes never reach staff impersonating', () => {
    for (const action of ['crm.prospects.read', 'crm.prospects.write', 'crm.prospects.confidential'] as const) {
      expect(can(agent, action, { agencyId: AGENCY })).toBe(true);
      expect(can(agent, action, { agencyId: OTHER_AGENCY })).toBe(false);
      expect(can(ctxAs('PARTNER'), action)).toBe(false);
      expect(can({ ...agent, clientMode: true }, action)).toBe(false);
    }
    const impersonated = ctxAs('AGENT', {
      kind: 'user',
      userId: '01900000-0000-7000-8000-0000000000aa',
      role: 'AGENT',
      impersonatedBy: STAFF,
    });
    expect(can(impersonated, 'crm.prospects.read')).toBe(true);
    expect(can(impersonated, 'crm.prospects.write')).toBe(false);
    expect(can(impersonated, 'crm.prospects.confidential')).toBe(false);
  });

  it('[S10-01] denies other agencies and non-user actors', () => {
    expect(can(agent, 'crm.contacts.read', { agencyId: OTHER_AGENCY })).toBe(false);
    expect(can(ctxAs('AGENT', { kind: 'system', reason: 'test' }), 'crm.contacts.read')).toBe(false);
  });

  it('[S10-01] nothing of the CRM is open in Client Mode (owner contacts never shown to a client)', () => {
    expect(CLIENT_MODE_ALLOWED.size).toBe(0);
    for (const action of CRM_ACTIONS) expect(can({ ...admin, clientMode: true }, action)).toBe(false);
  });

  it('[S10-01] staff impersonating a member may read contacts, never change, merge or import them', () => {
    expectImpersonationRules({
      actions: CRM_ACTIONS,
      rules: CRM_IMPERSONATION,
      can: (ctx, action) => can(ctx, action, { agencyId: AGENCY }),
      admin,
      staffUserId: STAFF,
    });
  });
});
