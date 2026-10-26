import { PortalQuery, type WebsiteListingDetail } from '@inmolink/contracts';
import type {
  PortalAgencyProfile,
  PortalDevelopment,
  PortalListing,
  PortalLocation,
  PortalZone,
} from '@inmolink/core/modules/website-api';
import { UI_LOCALES } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { JsonLd } from './ui/breadcrumbs';

/**
 * S15-F7: the portal pages' metadata (title, description, canonical, hreflang, robots, Open Graph, Twitter) and their
 * inline JSON-LD, as the pages render them — compared with a golden file recorded from the pages before their SEO
 * building moved into core (`website-api/portal-seo.ts`), so the move changed no byte. Each page's data comes from
 * fixtures (`@/portal/data` mocked); the page's element tree is walked, not rendered (its views are async).
 */

const ORIGIN = 'https://inmolink.test';
const AGENCY_ID = '01900000-0000-7000-8000-0000000000a1';
const LISTING_ID = '01900000-0000-7000-8000-0000000000c3';
const DEV_ID = '01900000-0000-7000-8000-0000000000e1';

const taxon = (id: string, name: string) => ({ id, name, slug: name.toLowerCase() });
const PLACE = {
  country: taxon('01900000-0000-7000-8000-0000000000d1', 'Spain'),
  region: taxon('01900000-0000-7000-8000-0000000000d2', 'Alicante'),
  city: taxon('01900000-0000-7000-8000-0000000000d3', 'Rojales'),
  area: null,
};
const presenter = {
  name: 'Move Homes',
  email: null,
  phone: null,
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
};
const agency = { id: AGENCY_ID, name: 'Move Homes', email: null, phone: null, website: null };

const urls = (n: string) => ({
  small: `https://media.test/${n}/s.webp`,
  medium: `https://media.test/${n}/m.webp`,
  large: `https://media.test/${n}/l.webp`,
  og: `https://media.test/${n}/og.webp`,
});

/** A listing with a cover, images, geo and a long description with markup-like text (`</script>`, `&`, U+2028). */
function listingOf(locale: string, over: Partial<WebsiteListingDetail> = {}): PortalListing {
  const detail = {
    kind: 'LISTING',
    id: LISTING_ID,
    ref: 'MH-101',
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: 24_999_500, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('01900000-0000-7000-8000-0000000000b1', locale === 'es' ? 'Chalet' : 'Villa'),
    place: PLACE,
    bedrooms: 3,
    bathrooms: 1,
    builtM2: 85,
    plotM2: 200,
    geo: { lat: 38.08, lng: -0.72 },
    cover: { kind: 'IMAGE', urls: urls('cover') },
    imageCount: 3,
    developmentId: null,
    developmentRef: null,
    title: 'Beautiful villa',
    slug: 'beautiful-villa',
    textLocale: null,
    description: `A villa with a pool </script><script>alert(1)</script> & a garden line para. ${'Sunny terrace and sea views. '.repeat(30)}`,
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
    media: [
      { kind: 'IMAGE', urls: urls('cover') },
      { kind: 'IMAGE', urls: { large: 'https://media.test/b/l.webp' } },
      { kind: 'VIDEO', urls: urls('video') },
    ],
    agency: presenter,
    ...over,
  } as unknown as Extract<WebsiteListingDetail, { kind: 'LISTING' }>;
  return {
    detail,
    code: 'M2Q7ZK4P',
    agency,
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    developmentCode: null,
    paths: { en: '/en/property/villa-in-rojales-m2q7zk4p', es: '/es/property/chalet-en-rojales-m2q7zk4p' },
  };
}

function developmentOf(priced: boolean): PortalDevelopment {
  return {
    code: 'D4V3K0PM',
    agency,
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    moreUnits: false,
    paths: { en: '/en/development/marina-heights-d4v3k0pm', es: '/es/development/marina-heights-d4v3k0pm' },
    units: [],
    detail: {
      kind: 'DEVELOPMENT',
      id: DEV_ID,
      ref: 'DV-7',
      name: 'Marina Heights',
      title: 'Seaside living',
      slug: 'seaside-living',
      textLocale: null,
      status: 'UNDER_CONSTRUCTION',
      completionDate: '2027-06-30',
      place: PLACE,
      geo: { lat: 38.1, lng: -0.7 },
      price: priced
        ? { fromCents: 25_000_000, toCents: 30_000_000, currency: 'EUR' }
        : { fromCents: null, toCents: null, currency: 'EUR' },
      bedrooms: { min: 1, max: 3 },
      units: { total: 2, available: 1, reserved: 1 },
      description: 'Two blocks by the marina <b>& more</b>.',
      paymentTerms: null,
      metaTitle: null,
      metaDescription: null,
      agency: presenter,
    },
  } as unknown as PortalDevelopment;
}

const place = (id: string, name: string, path: string[]) => ({ id, level: 'CITY' as const, name, path });
const LOCATION: PortalLocation = {
  place: place('01900000-0000-7000-8000-0000000000d3', 'Rojales', ['spain', 'alicante', 'rojales']),
  ancestors: [
    { ...place('01900000-0000-7000-8000-0000000000d1', 'Spain', ['spain']), level: 'COUNTRY' },
    { ...place('01900000-0000-7000-8000-0000000000d2', 'Alicante', ['spain', 'alicante']), level: 'REGION' },
  ],
  children: [],
};
const ZONE: PortalZone = {
  id: '01900000-0000-7000-8000-0000000000f9',
  name: 'Costa Blanca South',
  slug: 'costa-blanca-south',
  members: [LOCATION.place],
};

function profileOf(over: Partial<PortalAgencyProfile> = {}): PortalAgencyProfile {
  return {
    id: AGENCY_ID,
    name: 'Move Homes',
    email: 'hola@move.example',
    phone: '+34 600 000 000',
    website: 'https://move.example',
    kind: 'AGENCY',
    registerNumber: 'AICAT-4711',
    languages: ['es', 'en'],
    city: 'Rojales',
    tagline: 'Homes by the sea',
    description: 'We sell homes on the coast.\n\nSince 1998 <script>.',
    textLocale: 'en',
    paths: { en: `/en/agency/${AGENCY_ID}/move-homes`, es: `/es/agency/${AGENCY_ID}/move-homes` },
    ...over,
  };
}

const RESULT = {
  items: [],
  total: 42,
  page: 1,
  pageCount: 3,
  typeCounts: {},
  locationCounts: {},
  degraded: false,
  pageUnavailable: false,
};

/** What the mocked reads answer for the current case. */
const data: {
  listing: (locale: string) => PortalListing | null;
  development: PortalDevelopment | null;
  agency: PortalAgencyProfile | null;
} = { listing: (l) => listingOf(l), development: developmentOf(true), agency: profileOf() };

vi.mock('next-intl/server', () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: 'portal' }) =>
    translator(locale, namespace),
  setRequestLocale: () => {},
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  permanentRedirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
// S15-F7: the ISR pages' cache tags (Next's `unstable_cache` needs a running server).
const tagged = vi.hoisted(() => [] as string[][]);
vi.mock('@/portal/cache-tags', () => ({
  tagPage: async (tags: readonly string[]) => {
    tagged.push([...tags]);
  },
}));
vi.mock('@/portal/legacy', () => ({ legacyRedirectFor: async () => null }));
vi.mock('@/portal/ui/map-toggle', () => ({ MapToggle: () => null }));
vi.mock('@/portal/data', () => ({
  PORTAL_LOCALES: UI_LOCALES,
  assertPortalLocale: () => {},
  portalSettings: async () => ({ origin: ORIGIN, map: null, turnstileSiteKey: null }),
  parseQuery: (p: Record<string, string | string[] | undefined>) => PortalQuery.parse(p),
  listingByCode: async (locale: string) => data.listing(locale),
  developmentByCode: async () => data.development,
  agencyOf: async () => data.agency,
  locationOf: async () => LOCATION,
  zoneOf: async () => ZONE,
  placeOf: async () => ({ place: LOCATION.place, ancestors: LOCATION.ancestors }),
  catalogOf: async () => ({ groups: [], features: [] }),
  directoryOf: async () => ({ countries: [], zones: [] }),
  locationPaths: async () => ({ en: ['spain', 'alicante', 'rojales'], es: ['espana', 'alicante', 'rojales'] }),
  zoneSlugs: async () => ({ en: 'costa-blanca-south', es: 'costa-blanca-sur' }),
  searchPortal: async (input: { query: PortalQuery }) => ({ ...RESULT, page: input.query.page ?? 1 }),
}));

/** The JSON-LD scripts and breadcrumbs a page's element tree carries, in order. */
function collect(node: ReactNode, out: { jsonLd: string[]; crumbs: unknown[] }) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as { json?: string; crumbs?: unknown; children?: ReactNode; title?: unknown };
  if (node.type === JsonLd) out.jsonLd.push(props.json as string);
  if (props.crumbs) out.crumbs.push(props.crumbs);
  collect(props.children, out);
  return out;
}

type PageModule = {
  default: (p: unknown) => Promise<ReactNode>;
  generateMetadata: (p: unknown) => Promise<unknown>;
};

async function renderCase(mod: PageModule, params: Record<string, unknown>, query: Record<string, string> = {}) {
  const props = { params: Promise.resolve(params), searchParams: Promise.resolve(query) };
  const metadata = await mod.generateMetadata(props);
  const tree = collect(await mod.default(props), { jsonLd: [], crumbs: [] });
  return { metadata, ...tree };
}

const pages = {
  listing: () => import('@/app/[locale]/property/[slug]/page'),
  development: () => import('@/app/[locale]/development/[slug]/page'),
  search: () => import('@/app/[locale]/properties/page'),
  location: () => import('@/app/[locale]/properties/[...location]/page'),
  zone: () => import('@/app/[locale]/zone/[zone]/page'),
  agency: () => import('@/app/[locale]/agency/[id]/[name]/page'),
  home: () => import('@/app/[locale]/page'),
} as unknown as Record<string, () => Promise<PageModule>>;

const page = (name: string) => (pages[name] as () => Promise<PageModule>)();

describe('portal page metadata and JSON-LD (S15-F7)', () => {
  it('[S15-F7] listing, development, location, zone, search, agency and home pages render the recorded metadata and JSON-LD', async () => {
    const out: Record<string, unknown> = {};
    for (const locale of ['en', 'es']) {
      data.listing = (l) => listingOf(l);
      out[`listing.${locale}`] = await renderCase(await page('listing'), {
        locale,
        slug: (listingOf(locale).paths[locale] as string).split('/').pop(),
      });
    }
    data.listing = (l) =>
      listingOf(l, {
        price: { amountCents: null, currency: 'EUR', period: null, onRequest: true },
        metaDescription: 'Own meta description',
        cover: null,
        media: [],
        geo: null,
        description: null,
      } as Partial<WebsiteListingDetail>);
    out['listing.onRequest'] = await renderCase(await page('listing'), {
      locale: 'en',
      slug: 'villa-in-rojales-m2q7zk4p',
    });
    data.listing = (l) => listingOf(l);

    for (const priced of [true, false]) {
      data.development = developmentOf(priced);
      out[`development.${priced ? 'priced' : 'unpriced'}`] = await renderCase(await page('development'), {
        locale: 'en',
        slug: 'marina-heights-d4v3k0pm',
      });
    }
    out['development.es'] = await renderCase(await page('development'), {
      locale: 'es',
      slug: 'marina-heights-d4v3k0pm',
    });

    out['search.en'] = await renderCase(await page('search'), { locale: 'en' });
    out['search.es.filtered.page2'] = await renderCase(
      await page('search'),
      { locale: 'es' },
      { page: '2', bedrooms_min: '2', sort: 'price_asc' },
    );

    out['location.en'] = await renderCase(await page('location'), {
      locale: 'en',
      location: ['spain', 'alicante', 'rojales'],
    });
    out['location.en.page3.filtered'] = await renderCase(
      await page('location'),
      { locale: 'en', location: ['spain', 'alicante', 'rojales'] },
      { page: '3', type: 'villa' },
    );

    out['zone.en'] = await renderCase(await page('zone'), { locale: 'en', zone: 'costa-blanca-south' });
    out['zone.es.page2'] = await renderCase(
      await page('zone'),
      { locale: 'es', zone: 'costa-blanca-south' },
      {
        page: '2',
      },
    );

    data.agency = profileOf();
    out['agency.en'] = await renderCase(await page('agency'), {
      locale: 'en',
      id: AGENCY_ID,
      name: 'move-homes',
    });
    data.agency = profileOf({
      tagline: null,
      description: null,
      city: null,
      kind: 'DEVELOPER',
      website: 'javascript:x',
    });
    out['agency.es.bare.page2'] = await renderCase(
      await page('agency'),
      { locale: 'es', id: AGENCY_ID, name: 'move-homes' },
      { page: '2' },
    );

    for (const locale of ['en', 'es']) out[`home.${locale}`] = await renderCase(await page('home'), { locale });

    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot('./__golden__/portal-seo.golden.json');
  });

  it('[S15-F7] listing and development pages tag their ISR copy with the listing or development, its code and its agency; a 404 with its code', async () => {
    tagged.length = 0;
    data.listing = (l) => listingOf(l);
    data.development = developmentOf(true);
    await renderCase(await page('listing'), { locale: 'en', slug: 'villa-in-rojales-m2q7zk4p' });
    await renderCase(await page('development'), { locale: 'en', slug: 'marina-heights-d4v3k0pm' });
    await renderCase(await page('search'), { locale: 'en' });
    // A code no listing has any more: its 404 carries the code (a restored listing comes back).
    data.listing = () => null;
    await expect(
      renderCase(await page('listing'), { locale: 'en', slug: 'villa-in-rojales-m2q7zk4p' }),
    ).rejects.toThrow('notFound');
    data.listing = (l) => listingOf(l);
    expect(tagged).toEqual([
      [`portal:t:${LISTING_ID}`, 'portal:c:M2Q7ZK4P', `portal:a:${AGENCY_ID}`],
      [`portal:d:${DEV_ID}`, 'portal:c:D4V3K0PM', `portal:a:${AGENCY_ID}`],
      ['portal:c:M2Q7ZK4P'],
    ]);
  });
});
