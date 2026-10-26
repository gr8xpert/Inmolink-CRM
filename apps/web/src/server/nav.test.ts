import type { MyCapabilitiesDto } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { buildNav } from './nav';

const member = (over: Partial<MyCapabilitiesDto>) => ({
  kind: 'member' as const,
  caps: { role: 'AGENT' as const, clientMode: false, impersonating: false, sections: [], ...over },
});
const keys = (identity: Parameters<typeof buildNav>[0]) => buildNav(identity).map((i) => i.key);

describe('dashboard navigation', () => {
  it('[S1-10] role-based navigation: members see exactly the sections the API grants, in a fixed order', () => {
    const admin = member({
      role: 'AGENCY_ADMIN',
      sections: [
        'staffAccess',
        'apiKeys',
        'team',
        'verification',
        'settings',
        'profile',
        'preferredAgencies',
        'listings',
      ],
    });
    expect(keys(admin)).toEqual([
      'home',
      'listings',
      'team',
      'preferredAgencies',
      'profile',
      'settings',
      'verification',
      'apiKeys',
      'staffAccess',
      'support',
      'security',
    ]);
    expect(keys(member({ sections: ['team', 'settings', 'preferredAgencies'] }))).toEqual([
      'home',
      'team',
      'preferredAgencies',
      'settings',
      'support',
      'security',
    ]);
    expect(buildNav(admin).find((i) => i.key === 'apiKeys')?.href).toBe('/api-keys');
    expect(buildNav(admin).find((i) => i.key === 'listings')?.href).toBe('/listings');
  });

  it('[S14-F5] the selections section links to /selections, after the inbox; Client Mode is never offered it by the API', () => {
    const items = buildNav(member({ sections: ['selections', 'inbox', 'listings'] }));
    expect(items.map((i) => [i.key, i.href]).slice(1, 4)).toEqual([
      ['listings', '/listings'],
      ['inbox', '/inbox'],
      ['selections', '/selections'],
    ]);
  });

  it('[S12-F1] the board and chat sections link to their pages, after network search', () => {
    const items = buildNav(member({ sections: ['chat', 'networkBoard', 'network', 'listings'] }));
    expect(items.map((i) => [i.key, i.href])).toEqual([
      ['home', '/'],
      ['listings', '/listings'],
      ['network', '/network'],
      ['networkBoard', '/network/board'],
      ['chat', '/chat'],
      ['support', '/support'],
      ['security', '/account/security'],
    ]);
  });

  it('[S1-10] staff links only for staff; none while impersonating, and no account security then', () => {
    expect(keys({ kind: 'staff', role: 'STAFF_SUPPORT' })).toEqual([
      'home',
      'security',
      'staffConsole',
      'staffVerification',
    ]);
    expect(keys({ kind: 'staff', role: 'STAFF_DATA_OPS' })).toEqual(['home', 'security', 'staffConsole']);
    const acting = keys(member({ impersonating: true, sections: ['team'] }));
    expect(acting).toEqual(['home', 'team', 'support']);
    expect(acting).not.toContain('staffConsole');
    // The API said nothing (refused or down): only what every account has.
    expect(keys({ kind: 'unknown' })).toEqual(['home', 'security']);
  });

  it('[S13-05] every member gets the support link, except in Client Mode', () => {
    expect(keys(member({ sections: [] }))).toEqual(['home', 'support', 'security']);
    expect(keys(member({ clientMode: true, sections: [] }))).not.toContain('support');
  });
});
