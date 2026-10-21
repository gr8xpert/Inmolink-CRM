import { describe, expect, it } from 'vitest';
import {
  CreateSiteBody,
  SiteContact,
  SiteInventoryFilters,
  UpdateSiteBody,
  WebsiteCard,
  WebsiteListingCard,
} from './websites';

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
  });

  it('[S7-F4] a minimum commission is a share of the price on network listings', () => {
    const ok = SiteInventoryFilters.parse({ includeNetwork: true, minCommissionBp: 300 });
    expect(ok.minCommissionBp).toBe(300);
    // Own listings are never filtered by it: without network listings it means nothing.
    expect(SiteInventoryFilters.safeParse({ minCommissionBp: 300 }).success).toBe(false);
    for (const bp of [0, 10_001, 2.5, -1]) {
      expect(SiteInventoryFilters.safeParse({ includeNetwork: true, minCommissionBp: bp }).success, String(bp)).toBe(
        false,
      );
    }
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

describe('website documents (S7-02)', () => {
  const TAXON = { id: LOC, name: 'Villa', slug: 'villa' };
  const card = {
    kind: 'LISTING',
    id: LOC,
    ref: 'CH-AB12CD34',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 100, currency: 'EUR', period: null, onRequest: false },
    propertyType: TAXON,
    place: { country: TAXON, region: null, city: null, area: null },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 120,
    plotM2: null,
    geo: null,
    cover: null,
    imageCount: 0,
    developmentId: null,
    developmentRef: null,
    title: 'Villa',
    slug: 'villa',
    textLocale: null,
  };

  it('[S7-02] strict shapes: no owner or commission field can be served', () => {
    expect(WebsiteListingCard.safeParse(card).success).toBe(true);
    for (const extra of [{ commissionBp: 300 }, { ownerAgencyId: LOC }, { ownerAgencyName: 'Owner' }]) {
      expect(WebsiteListingCard.safeParse({ ...card, ...extra }).success).toBe(false);
    }
    expect(WebsiteCard.safeParse({ ...card, agency: { name: 'Owner' } }).success).toBe(false);
  });
});
