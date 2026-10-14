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
      sections: ['staffAccess', 'apiKeys', 'team', 'verification', 'settings', 'profile', 'preferredAgencies'],
    });
    expect(keys(admin)).toEqual([
      'home',
      'team',
      'preferredAgencies',
      'profile',
      'settings',
      'verification',
      'apiKeys',
      'staffAccess',
      'security',
    ]);
    expect(keys(member({ sections: ['team', 'settings', 'preferredAgencies'] }))).toEqual([
      'home',
      'team',
      'preferredAgencies',
      'settings',
      'security',
    ]);
    expect(buildNav(admin).find((i) => i.key === 'apiKeys')?.href).toBe('/api-keys');
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
    expect(acting).toEqual(['home', 'team']);
    expect(acting).not.toContain('staffConsole');
    // The API said nothing (refused or down): only what every account has.
    expect(keys({ kind: 'unknown' })).toEqual(['home', 'security']);
  });
});
