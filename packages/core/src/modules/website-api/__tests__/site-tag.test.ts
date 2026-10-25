import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SiteScope } from '../../websites';
import { apiSiteOf } from '../service';
import { configureWebsiteApi } from '../settings';

// The give-to-get standing is a cached database read; these sites are open.
vi.mock('../../search', async (original) => ({
  ...(await original<typeof import('../../search')>()),
  websiteNetworkOpen: async () => true,
}));

const AGENCY = '0192f0a0-0000-7000-8000-00000000000a';

const site = (siteId: string, minCommissionBp: number): SiteScope => ({
  siteId,
  agencyId: AGENCY,
  name: 'Site',
  domains: ['agency.example'],
  version: 1,
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'CUSTOM',
  inventoryFilters: {
    includeOwn: true,
    includeNetwork: true,
    locationIds: [],
    propertyTypeIds: [],
    newBuilds: true,
    minCommissionBp,
  },
  referencePrefix: 'AG',
  locales: ['en'],
  defaultLocale: 'en',
  contact: null,
  presenter: {
    name: 'Agency',
    email: null,
    phone: null,
    whatsapp: null,
    website: null,
    primaryColor: null,
    accentColor: null,
  },
  verified: true,
  plan: null,
  planEndsAt: null,
});

beforeAll(() => {
  configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: 'site-tag-test-key-0123456789abcdef' });
});

describe('website-api site tag', () => {
  it('[S8-F4] two sites differing only in minimum commission get unrelated tags, not a SHA-256 of the settings', async () => {
    const a = await apiSiteOf(site('0192f0a0-0000-7000-8000-0000000000a1', 300), null, 'r1');
    const b = await apiSiteOf(site('0192f0a0-0000-7000-8000-0000000000a2', 400), null, 'r2');
    const again = await apiSiteOf(site('0192f0a0-0000-7000-8000-0000000000a3', 300), null, 'r3');

    expect(a.tag).toMatch(/^[\w-]{16}$/);
    // Stable for the same rules (a plugin resyncs only when they change), different when the commission differs.
    expect(again.tag).toBe(a.tag);
    expect(b.tag).not.toBe(a.tag);
    // Unrelated: no shared prefix beyond chance.
    expect(a.tag.slice(0, 4)).not.toBe(b.tag.slice(0, 4));

    // Not guessable without HMAC_KEY: the plain SHA-256 of the rules (what S7 sent) does not reproduce it.
    const inv = a.inventory;
    if (!inv) throw new Error('site shows nothing');
    const plain = createHash('sha256')
      .update(
        JSON.stringify([inv.ownerAgencyIds, inv.networkOf ?? null, inv.networkRefPrefix ?? null, inv.restrict ?? null]),
      )
      .digest('base64url')
      .slice(0, 16);
    expect(a.tag).not.toBe(plain);

    // Another HMAC_KEY gives another tag for the same rules: the key is what makes it.
    configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: 'another-site-tag-key-0123456789abcd' });
    try {
      const rekeyed = await apiSiteOf(site('0192f0a0-0000-7000-8000-0000000000a1', 300), null, 'r4');
      expect(rekeyed.tag).not.toBe(a.tag);
    } finally {
      configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: 'site-tag-test-key-0123456789abcdef' });
    }
  });
});
