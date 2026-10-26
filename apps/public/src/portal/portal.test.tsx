import { PortalQuery, type WebsiteListingDetail } from '@inmolink/contracts';
import type { PortalDevelopment, PortalListing } from '@inmolink/core/modules/website-api';
import { translator } from '@inmolink/i18n/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { localRedirectTarget } from './legacy';
import { breadcrumbJsonLd, listingJsonLd, serializeJsonLd } from './seo';
import { DevelopmentView } from './ui/development';
import { ListingView } from './ui/listing';
import { pageNumbers } from './ui/results';
import { languageName } from './ui/shell';
import {
  AGENCY_PROFILES_LIVE,
  agencyPath,
  codeOfSlug,
  hasFilters,
  listingPath,
  mailtoHref,
  queryString,
  safeHttpUrl,
  searchPath,
} from './urls';

// Server components translate on the server: the same catalogs, without a request.
vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: 'portal' }) =>
    translator(locale, namespace),
}));
// The map's client island is not part of these checks.
vi.mock('./ui/map-toggle', () => ({ MapToggle: () => null }));

describe('portal URLs and query (S15-01)', () => {
  it('[S15-01] listing URLs: "<type> in <town>" slug + public code, read back from the slug', () => {
    expect(listingPath('es', 'Ático en Málaga Este', 'M2Q7ZK4P')).toBe('/es/property/atico-en-malaga-este-m2q7zk4p');
    const path = listingPath('en', 'Villa in Rojales', 'M2Q7ZK4P');
    expect(path).toBe('/en/property/villa-in-rojales-m2q7zk4p');
    expect(codeOfSlug(path.split('/').pop() as string)).toBe('M2Q7ZK4P');
    expect(codeOfSlug('villa-in-rojales')).toBeNull();
    expect(searchPath('es', ['spain', 'alicante'])).toBe('/es/properties/spain/alicante');
  });

  it('[S15-01] crawlable numbered pages: one spelling per search, defaults dropped, gaps marked', () => {
    const q = PortalQuery.parse({ type: ['villa', 'apartment'], price_min: '100000', sort: 'latest', page: '1' });
    expect(queryString(q)).toBe('?type=apartment&type=villa&price_min=100000');
    expect(queryString(q, { page: 3 })).toBe('?type=apartment&type=villa&price_min=100000&page=3');
    expect(hasFilters(PortalQuery.parse({ page: '4' }))).toBe(false);
    expect(hasFilters(q)).toBe(true);
    expect(pageNumbers(6, 20)).toEqual([1, -1, 4, 5, 6, 7, 8, -8, 20]);
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
  });

  it('[S15-01] junk in the query string is dropped, never an error page', () => {
    const q = PortalQuery.parse({
      price_min: 'lots',
      price_max: '',
      bedrooms_min: ['2', '9'],
      type: ['villa', '<script>', 'villa'],
      feature: ['sea-views', 'pool'],
      sort: 'random',
      page: '99999',
    });
    expect(q).toMatchObject({ bedrooms_min: 2, type: ['villa'], feature: ['sea-views'] });
    expect(q.price_min).toBeUndefined();
    expect(q.price_max).toBeUndefined();
    expect(q.sort).toBeUndefined();
    expect(q.page).toBeUndefined();
  });

  it('[S15-01] agency websites: only http(s) URLs become links (no javascript:, data: or relative)', () => {
    expect(safeHttpUrl('https://costa-homes.example/en')).toBe('https://costa-homes.example/en');
    expect(safeHttpUrl('http://costa-homes.example')).toBe('http://costa-homes.example/');
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', '/relative', '']) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe('portal links and redirects (S15-01 review)', () => {
  it('[S15-01] no link to an agency profile page before S15-03 builds them', () => {
    expect(AGENCY_PROFILES_LIVE).toBe(false);
    expect(agencyPath('en', { id: '01900000-0000-7000-8000-0000000000a1', name: 'Move Homes' })).toBeNull();
  });

  it('[S15-01] legacy redirects stay on the portal: only same-origin paths, never //host or /\\host', () => {
    expect(localRedirectTarget('/en/properties/spain')).toBe('/en/properties/spain');
    const bad = ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'en/x', '', null, '/a\nb', '/a\\b'];
    for (const target of bad) expect(localRedirectTarget(target), String(target)).toBeNull();
  });

  it('[S15-01] mail links only for a plain address, encoded; no extra headers can be injected', () => {
    expect(mailtoHref('sales@move-homes.example', 'Villa (MH-1)')).toBe(
      'mailto:sales@move-homes.example?subject=Villa%20(MH-1)',
    );
    expect(mailtoHref('o.neil+homes@move.example', 'x')).toBe('mailto:o.neil%2Bhomes@move.example?subject=x');
    for (const bad of [
      'a@b.example?bcc=x@y.example',
      'a b@c.example',
      'javascript:alert(1)',
      'a@b',
      '<a@b.example>',
      null,
    ]) {
      expect(mailtoHref(bad, 'x'), String(bad)).toBeNull();
    }
  });

  it('[S15-01] language names come from Intl, each in its own language', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('es')).toBe('Español');
  });
});

describe('portal structured data (S15-01)', () => {
  it('[S15-01] JSON-LD: nothing in data can close the script tag', () => {
    const LS = String.fromCharCode(0x2028);
    const json = serializeJsonLd({ name: `</script><script>alert(1)</script>${LS}&` });
    expect(json).not.toMatch(/[<>&]/);
    expect(json).not.toContain(LS);
    expect(JSON.parse(json).name).toBe(`</script><script>alert(1)</script>${LS}&`);
  });

  it('[S15-01] JSON-LD: RealEstateListing with offer and agency; BreadcrumbList with positions', () => {
    const ld = listingJsonLd({
      url: 'https://inmolink.test/en/property/villa-in-rojales-m2q7zk4p',
      name: 'Villa in Rojales',
      description: 'A villa.',
      images: ['https://media.test/a/og.webp'],
      price: { amount: 249_995, currency: 'EUR' },
      bedrooms: 3,
      bathrooms: 1,
      builtM2: 85,
      address: { locality: 'Rojales', region: 'Alicante', country: 'Spain' },
      geo: null,
      agency: { name: 'Move Homes', url: 'https://inmolink.test/en/agency/x/move-homes' },
      dateModified: '2026-10-26T00:00:00.000Z',
    });
    expect(ld).toMatchObject({
      '@type': 'RealEstateListing',
      offers: { price: 249_995, priceCurrency: 'EUR', offeredBy: { '@type': 'RealEstateAgent', name: 'Move Homes' } },
      about: {
        numberOfBedrooms: 3,
        floorSize: { value: 85, unitCode: 'MTK' },
        address: { addressLocality: 'Rojales' },
      },
    });
    const crumbs = breadcrumbJsonLd('https://inmolink.test', [{ name: 'Home', path: '/en' }, { name: 'Villa' }]);
    expect(crumbs.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://inmolink.test/en' },
      { '@type': 'ListItem', position: 2, name: 'Villa' },
    ]);
  });
});

const taxon = (name: string) => ({ id: '01900000-0000-7000-8000-0000000000d1', name, slug: name.toLowerCase() });

function listing(website: string | null, developmentCode: string | null = null): PortalListing {
  const detail: WebsiteListingDetail = {
    kind: 'LISTING',
    id: '01900000-0000-7000-8000-0000000000c3',
    ref: 'MH-101',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 24_999_500, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa'),
    place: { country: taxon('Spain'), region: taxon('Alicante'), city: taxon('Rojales'), area: null },
    bedrooms: 3,
    bathrooms: 1,
    builtM2: 85,
    plotM2: 200,
    geo: null,
    cover: null,
    imageCount: 0,
    developmentId: null,
    developmentRef: null,
    title: 'Beautiful villa',
    slug: 'beautiful-villa',
    textLocale: null,
    description: 'A villa with a pool.',
    metaTitle: null,
    metaDescription: null,
    terraceM2: null,
    yearBuilt: null,
    priceToCents: null,
    communityFeeMonthCents: null,
    ibiYearCents: null,
    garbageTaxYearCents: null,
    energyRating: 'B',
    energyEmissionsRating: null,
    features: [],
    media: [],
    agency: {
      name: 'Move Homes',
      email: null,
      phone: null,
      whatsapp: null,
      website,
      primaryColor: null,
      accentColor: null,
    },
  };
  return {
    detail,
    code: 'M2Q7ZK4P',
    agency: { id: '01900000-0000-7000-8000-0000000000a1', name: 'Move Homes', email: null, phone: null, website },
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    developmentCode,
    paths: { en: '/en/property/villa-in-rojales-m2q7zk4p', es: '/es/property/chalet-en-rojales-m2q7zk4p' },
  };
}

const renderListing = async (website: string | null, developmentCode: string | null = null) =>
  renderToStaticMarkup(
    await ListingView({
      locale: 'en',
      listing: listing(website, developmentCode),
      title: 'Villa in Rojales',
      crumbs: [{ name: 'Home', path: '/en' }, { name: 'Villa in Rojales' }],
      settings: { origin: 'https://inmolink.test', map: null, turnstileSiteKey: 'turnstile-site-key' },
    }),
  );

describe('portal listing page (S15-01)', () => {
  it('[S15-01] the listing agency is named (no profile link until S15-03); a javascript: or data: website renders no link', async () => {
    const ok = await renderListing('https://move-homes.example');
    expect(ok).toContain('Move Homes');
    expect(ok).not.toContain('/agency/');
    expect(ok).toContain('href="https://move-homes.example/"');
    expect(ok).toContain('rel="nofollow noopener noreferrer"');
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
      const html = await renderListing(bad);
      expect(html).not.toMatch(/javascript:|data:text/i);
      expect(html).not.toContain('Agency website');
    }
  });

  it('[S15-01] facts from data: price, reference, sizes; no commission or internal fields', async () => {
    const html = await renderListing(null);
    expect(html).toContain('€249,995');
    expect(html).toContain('MH-101');
    expect(html).toContain('85 m²');
    expect(html).not.toMatch(/commission|internal/i);
  });
});

describe('portal development page (S15-01)', () => {
  const dev: PortalDevelopment = {
    code: 'D4V3L0PM',
    agency: { id: '01900000-0000-7000-8000-0000000000a1', name: 'Move Homes', email: null, phone: null, website: null },
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    moreUnits: false,
    paths: { en: '/en/development/marina-d4v3l0pm', es: '/es/development/marina-d4v3l0pm' },
    detail: {
      kind: 'DEVELOPMENT',
      id: '01900000-0000-7000-8000-0000000000e1',
      ref: 'DV-7',
      name: 'Marina Heights',
      title: 'Seaside living',
      slug: 'seaside-living',
      textLocale: null,
      status: 'UNDER_CONSTRUCTION',
      completionDate: '2027-06-30',
      place: { country: taxon('Spain'), region: taxon('Alicante'), city: taxon('Rojales'), area: null },
      geo: null,
      price: { fromCents: 25_000_000, toCents: 30_000_000, currency: 'EUR' },
      bedrooms: { min: 1, max: 3 },
      units: { total: 2, available: 1, reserved: 1 },
      description: 'Two blocks by the marina.',
      paymentTerms: '10 % on reservation.',
      metaTitle: null,
      metaDescription: null,
      agency: {
        name: 'Move Homes',
        email: null,
        phone: null,
        whatsapp: null,
        website: null,
        primaryColor: null,
        accentColor: null,
      },
    },
    units: [
      {
        kind: 'UNIT',
        id: '01900000-0000-7000-8000-0000000000f1',
        ref: 'A-1',
        status: 'AVAILABLE',
        price: { amountCents: 25_000_000, currency: 'EUR', period: null, onRequest: false },
        propertyType: taxon('Apartment'),
        place: { country: taxon('Spain'), region: taxon('Alicante'), city: taxon('Rojales'), area: null },
        bedrooms: 1,
        bathrooms: 1,
        internalM2: 62,
        terraceM2: 12,
        plotM2: null,
        floor: 2,
        orientation: null,
        geo: null,
        development: {
          id: '01900000-0000-7000-8000-0000000000e1',
          ref: 'DV-7',
          name: 'Marina Heights',
          status: 'UNDER_CONSTRUCTION',
          completionDate: '2027-06-30',
        },
        title: 'Seaside living',
        slug: 'seaside-living',
        textLocale: null,
      },
    ],
  };

  it('[S15-01] a development shows its price range, homes left and its unit table, with the listing agency', async () => {
    const html = renderToStaticMarkup(
      await DevelopmentView({
        locale: 'en',
        development: dev,
        title: 'Marina Heights',
        crumbs: [{ name: 'Home', path: '/en' }],
      }),
    );
    expect(html).toContain('€250,000 to €300,000');
    expect(html).toContain('1 home available, 1 reserved');
    expect(html).toContain('<caption');
    expect(html).toContain('62 m²');
    expect(html).toContain('Move Homes');
    expect(html).not.toMatch(/commission/i);
  });

  it('[S15-01] a listing that belongs to a development links to the development page', async () => {
    const html = await renderListing(null, 'D4V3L0PM');
    expect(html).toContain('/en/development/development-d4v3l0pm');
  });
});

describe('portal enquiry form (S15-02)', () => {
  it('[S15-02] the listing page carries the enquiry form: a plain POST with the code, consent text and Turnstile', async () => {
    const html = await renderListing('https://move-homes.example');
    expect(html).toContain('action="/api/portal/enquiry"');
    expect(html).toContain('method="post"');
    expect(html).toMatch(/name="code" value="[A-Z0-9]{8}"/);
    expect(html).toContain('name="back" value="/en/property/villa-in-rojales-');
    expect(html).toMatch(/<input type="checkbox" required=""[^>]*name="privacyAccepted"/);
    expect(html).toContain('I agree that Move Homes and Inmolink process my details');
    expect(html).toContain('data-sitekey="turnstile-site-key"');
    expect(html).toContain('data-action="website-lead"');
    // No third-party script on page load: Turnstile is loaded by the island on first use.
    expect(html).not.toContain('<script src="https://challenges.cloudflare.com');
  });

  it('[S15-02] without Turnstile configured there is no form, only a note (an enquiry could only be refused)', async () => {
    const html = renderToStaticMarkup(
      await ListingView({
        locale: 'es',
        listing: listing('https://move-homes.example'),
        title: 'Chalet en Rojales',
        crumbs: [{ name: 'Inicio', path: '/es' }],
        settings: { origin: 'https://inmolink.test', map: null, turnstileSiteKey: null },
      }),
    );
    expect(html).not.toContain('/api/portal/enquiry');
    expect(html).toContain('Las consultas no están disponibles ahora');
  });
});
