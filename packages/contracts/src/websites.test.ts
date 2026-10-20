import { describe, expect, it } from 'vitest';
import { CreateSiteBody, SiteContact, SiteInventoryFilters, UpdateSiteBody } from './websites';

const base = { name: 'Costa Homes', mode: 'WP_PLUGIN', locales: ['en', 'es'] };
const LOC = '01900000-0000-7000-8000-000000000001';

describe('website site contracts (S7-01)', () => {
  it('[S7-01] a CUSTOM policy comes with filters, the others without', () => {
    expect(CreateSiteBody.parse(base)).toMatchObject({ inventoryPolicy: 'OWN_ONLY', inventoryFilters: null });
    expect(CreateSiteBody.safeParse({ ...base, inventoryPolicy: 'CUSTOM' }).success).toBe(false);
    const filters = { includeNetwork: true, locationIds: [LOC] };
    expect(CreateSiteBody.parse({ ...base, inventoryPolicy: 'CUSTOM', inventoryFilters: filters })).toMatchObject({
      inventoryFilters: { includeOwn: true, includeNetwork: true, locationIds: [LOC], newBuilds: true },
    });
    expect(CreateSiteBody.safeParse({ ...base, inventoryPolicy: 'OWN_ONLY', inventoryFilters: filters }).success).toBe(
      false,
    );
  });

  it('[S7-01] filters show own or network listings, in a non-empty price band', () => {
    expect(SiteInventoryFilters.safeParse({ includeOwn: false, includeNetwork: false }).success).toBe(false);
    expect(SiteInventoryFilters.safeParse({ priceMinCents: 10, priceMaxCents: 5 }).success).toBe(false);
    expect(SiteInventoryFilters.safeParse({ locationIds: [LOC, LOC] }).success).toBe(false);
    expect(SiteInventoryFilters.safeParse({ minCommissionBp: 300 }).success).toBe(false);
  });

  it('[S7-01] prefix, domains, locales and contact are checked', () => {
    expect(CreateSiteBody.safeParse({ ...base, referencePrefix: 'ch' }).success).toBe(false);
    expect(CreateSiteBody.safeParse({ ...base, referencePrefix: 'TOOLONG' }).success).toBe(false);
    expect(CreateSiteBody.parse({ ...base, domains: ['WWW.Example.com'] }).domains).toEqual(['www.example.com']);
    expect(CreateSiteBody.safeParse({ ...base, domains: ['https://example.com'] }).success).toBe(false);
    expect(CreateSiteBody.safeParse({ ...base, locales: [] }).success).toBe(false);
    expect(SiteContact.safeParse({}).success).toBe(false);
    expect(SiteContact.safeParse({ email: 'sales@example.com', phone: '+34 600 000 000' }).success).toBe(true);
  });

  it('[S7-01] an edit names its version, and sends the policy with its filters', () => {
    expect(UpdateSiteBody.safeParse({ name: 'x' }).success).toBe(false);
    expect(UpdateSiteBody.safeParse({ version: 1, name: 'x' }).success).toBe(true);
    expect(UpdateSiteBody.safeParse({ version: 1, inventoryPolicy: 'OWN_PLUS_NETWORK' }).success).toBe(false);
    expect(
      UpdateSiteBody.safeParse({ version: 1, inventoryPolicy: 'OWN_PLUS_NETWORK', inventoryFilters: null }).success,
    ).toBe(true);
  });
});
