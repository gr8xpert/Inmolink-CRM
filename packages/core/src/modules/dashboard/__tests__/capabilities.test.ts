import { MyCapabilitiesDto } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { getMyCapabilities } from '../capabilities';

const AGENCY = '01900000-0000-7000-8000-000000000001';
const SELF = '01900000-0000-7000-8000-0000000000aa';
const STAFF = '01900000-0000-7000-8000-0000000000bb';

function ctxAs(role: string, over: { clientMode?: boolean; impersonatedBy?: string } = {}): Ctx {
  return {
    tx: {} as Ctx['tx'],
    tenant: { agencyId: AGENCY, verified: true, plan: 'test', locales: ['en'] },
    actor: {
      kind: 'user',
      userId: SELF,
      role,
      ...(over.impersonatedBy ? { impersonatedBy: over.impersonatedBy } : {}),
    },
    locale: 'en',
    requestId: 'test',
    clientMode: over.clientMode ?? false,
  };
}

describe('getMyCapabilities', () => {
  it('[S1-10] role-based navigation: admins of either family see every section, agents only the shared ones', () => {
    const all = [
      'listings',
      'pipeline',
      'tasks',
      'calendar',
      'acquisition',
      'network',
      'developments',
      'imports',
      'team',
      'websites',
      'portals',
      'apiKeys',
      'profile',
      'settings',
      'verification',
      'preferredAgencies',
      'staffAccess',
    ];
    for (const role of ['AGENCY_ADMIN', 'DEVELOPER_ADMIN']) {
      const caps = getMyCapabilities(ctxAs(role));
      expect(MyCapabilitiesDto.parse(caps)).toEqual({ role, clientMode: false, impersonating: false, sections: all });
    }
    for (const role of ['AGENT', 'DEVELOPER_AGENT']) {
      expect(getMyCapabilities(ctxAs(role)).sections).toEqual([
        'listings',
        'pipeline',
        'tasks',
        'calendar',
        'acquisition',
        'network',
        'developments',
        'imports',
        'team',
        'websites',
        'portals',
        'settings',
        'preferredAgencies',
      ]);
    }
  });

  it('[S1-10] Client Mode hides everything a client must not see (team, keys, settings, partners)', () => {
    // Listings stay: Client Mode shows properties, and the API strips commission and private fields (S3-02).
    expect(getMyCapabilities(ctxAs('AGENCY_ADMIN', { clientMode: true }))).toMatchObject({
      clientMode: true,
      sections: ['listings'],
    });
  });

  it('[S5-05] network search is a section for members, never in Client Mode (owner agencies and commission)', () => {
    expect(getMyCapabilities(ctxAs('AGENT')).sections).toContain('network');
    expect(getMyCapabilities(ctxAs('AGENT', { clientMode: true })).sections).not.toContain('network');
  });

  it('[S3-05] every member, partners included, gets the listings section', () => {
    for (const role of ['AGENCY_ADMIN', 'AGENT', 'DEVELOPER_AGENT', 'PARTNER']) {
      expect(getMyCapabilities(ctxAs(role)).sections[0]).toBe('listings');
    }
  });

  it('[S1-10] while impersonating, sections follow the impersonation rules and the flag is set', () => {
    const caps = getMyCapabilities(ctxAs('AGENCY_ADMIN', { impersonatedBy: STAFF }));
    expect(caps.impersonating).toBe(true);
    // Read-only areas stay visible; nothing forbidden to staff is offered (not the agency's staff-access record).
    expect(caps.sections).toEqual([
      'listings',
      'pipeline',
      'tasks',
      'calendar',
      'acquisition',
      'network',
      'developments',
      'imports',
      'team',
      'websites',
      'portals',
      'apiKeys',
      'profile',
      'settings',
      'verification',
      'preferredAgencies',
    ]);
  });

  it('[S1-10] only user actors have capabilities', () => {
    const system = { ...ctxAs('AGENT'), actor: { kind: 'system', reason: 'test' } } as Ctx;
    expect(() => getMyCapabilities(system)).toThrow('FORBIDDEN');
  });
});
