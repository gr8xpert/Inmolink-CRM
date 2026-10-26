/**
 * The portal pages' SEO (S15-F7, PATTERNS §19; moved from `apps/public/src/portal/{seo,meta}.ts`): titles, meta
 * descriptions, canonical and hreflang alternates, robots, Open Graph and Twitter cards (`portalMetadataFor`), the
 * breadcrumbs (`portalCrumbs`) and the structured data (`portalJsonLd`: schema.org `RealEstateListing`,
 * `RealEstateAgent`, `BreadcrumbList`) of every portal page, plus the cache tags of its ISR copy (`portalPageTags`).
 * Pure: the page has loaded its data through the portal read services (`portal.ts`) and names it here; nothing is read.
 * The app inlines JSON-LD with `serializeJsonLd` only (nothing in data can close the script).
 */
import { type PortalQuery, portalQueryHasFilters, portalQueryString } from '@inmolink/contracts';
import { DEFAULT_UI_LOCALE, formatter, UI_LOCALES } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { excerpt } from '../websites';
import type {
  PortalAgency,
  PortalAgencyProfile,
  PortalDevelopment,
  PortalListing,
  PortalLocation,
  PortalPlace,
  PortalZone,
} from './portal';
import {
  agencyPath,
  developmentNameOf,
  homePath,
  portalListingTitle,
  safeHttpUrl,
  searchPath,
  townOf,
  zonePath,
} from './portal-urls';

// ── JSON-LD building blocks ─────────────────────────────────────────────────────────────────────────────────────

/** Line and paragraph separators: valid in JSON, line breaks in older script parsers. */
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');

/** JSON for a `<script type="application/ld+json">`: nothing in data can close the script or open markup. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LS, '\\u2028')
    .replace(PS, '\\u2029');
}

export interface Crumb {
  name: string;
  /** Path on the portal's origin; the last crumb (the page itself) may have none. */
  path?: string;
}

export function breadcrumbJsonLd(origin: string, crumbs: readonly Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.path ? { item: `${origin}${c.path}` } : {}),
    })),
  };
}

export interface ListingLd {
  url: string;
  name: string;
  description: string | null;
  images: readonly string[];
  price: { amount: number; currency: string } | null;
  bedrooms: number | null;
  bathrooms: number | null;
  builtM2: number | null;
  address: { locality: string | null; region: string | null; country: string | null };
  geo: { lat: number; lng: number } | null;
  /** The listing agency; `url` its profile page. */
  agency: { name: string; url: string } | null;
  dateModified: string;
}

/** A schema.org `RealEstateAgent`: the listing agency and its profile page (S15-03). */
const agentLd = (a: { name: string; url: string }) => ({
  '@type': 'RealEstateAgent',
  name: a.name,
  url: a.url,
});

/** A listing as schema.org `RealEstateListing`, the home as its `about` (an `Accommodation`). */
export function listingJsonLd(l: ListingLd) {
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    url: l.url,
    name: l.name,
    ...(l.description ? { description: l.description } : {}),
    ...(l.images.length > 0 ? { image: l.images } : {}),
    dateModified: l.dateModified,
    ...(l.price
      ? {
          offers: {
            '@type': 'Offer',
            price: l.price.amount,
            priceCurrency: l.price.currency,
            availability: 'https://schema.org/InStock',
            ...(l.agency ? { offeredBy: agentLd(l.agency) } : {}),
          },
        }
      : {}),
    about: {
      '@type': 'Accommodation',
      ...(l.bedrooms !== null ? { numberOfBedrooms: l.bedrooms } : {}),
      ...(l.bathrooms !== null ? { numberOfBathroomsTotal: l.bathrooms } : {}),
      ...(l.builtM2 !== null ? { floorSize: { '@type': 'QuantitativeValue', value: l.builtM2, unitCode: 'MTK' } } : {}),
      address: {
        '@type': 'PostalAddress',
        ...(l.address.locality ? { addressLocality: l.address.locality } : {}),
        ...(l.address.region ? { addressRegion: l.address.region } : {}),
        ...(l.address.country ? { addressCountry: l.address.country } : {}),
      },
      ...(l.geo ? { geo: { '@type': 'GeoCoordinates', latitude: l.geo.lat, longitude: l.geo.lng } } : {}),
    },
  };
}

export interface DevelopmentLd {
  url: string;
  name: string;
  description: string | null;
  price: { low: number; high: number; currency: string } | null;
  available: number;
  address: { locality: string | null; region: string | null; country: string | null };
  geo: { lat: number; lng: number } | null;
  agency: { name: string; url: string } | null;
  dateModified: string;
}

/** A new-build development as schema.org `RealEstateListing` with an `AggregateOffer` over its available homes. */
export function developmentJsonLd(d: DevelopmentLd) {
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    url: d.url,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    dateModified: d.dateModified,
    ...(d.price
      ? {
          offers: {
            '@type': 'AggregateOffer',
            lowPrice: d.price.low,
            highPrice: d.price.high,
            priceCurrency: d.price.currency,
            offerCount: d.available,
            ...(d.agency ? { offeredBy: agentLd(d.agency) } : {}),
          },
        }
      : {}),
    about: {
      '@type': 'Residence',
      address: {
        '@type': 'PostalAddress',
        ...(d.address.locality ? { addressLocality: d.address.locality } : {}),
        ...(d.address.region ? { addressRegion: d.address.region } : {}),
        ...(d.address.country ? { addressCountry: d.address.country } : {}),
      },
      ...(d.geo ? { geo: { '@type': 'GeoCoordinates', latitude: d.geo.lat, longitude: d.geo.lng } } : {}),
    },
  };
}

export interface AgencyLd {
  url: string;
  name: string;
  description: string | null;
  email: string | null;
  telephone: string | null;
  /** The agency's own website (`safeHttpUrl` only). */
  website: string | null;
  city: string | null;
  /** Language codes it works in. */
  languages: readonly string[];
  registerNumber: string | null;
}

/**
 * S15-03: a listed agency's profile as schema.org `RealEstateAgent` (its page is its `@id`): only what it published —
 * contact details, town, languages and register number.
 */
export function agencyJsonLd(a: AgencyLd) {
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateAgent',
    '@id': a.url,
    url: a.url,
    name: a.name,
    ...(a.description ? { description: a.description } : {}),
    ...(a.email ? { email: a.email } : {}),
    ...(a.telephone ? { telephone: a.telephone } : {}),
    ...(a.website ? { sameAs: [a.website] } : {}),
    ...(a.city ? { address: { '@type': 'PostalAddress', addressLocality: a.city } } : {}),
    ...(a.languages.length > 0 ? { knowsLanguage: [...a.languages] } : {}),
    ...(a.registerNumber ? { identifier: { '@type': 'PropertyValue', value: a.registerNumber } } : {}),
  };
}

/** `alternates.languages`: each locale's absolute URL, plus `x-default` (the default locale). */
export function languageAlternates(
  origin: string,
  paths: Readonly<Record<string, string>>,
  defaultLocale: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [locale, path] of Object.entries(paths)) out[locale] = `${origin}${path}`;
  const fallback = paths[defaultLocale];
  if (fallback) out['x-default'] = `${origin}${fallback}`;
  return out;
}

// ── Agency texts ────────────────────────────────────────────────────────────────────────────────────────────────

/** An agency profile's tagline and about text as one summary (sentences closed), or null without either. */
export function portalProfileSummary(agency: Pick<PortalAgencyProfile, 'tagline' | 'description'>): string | null {
  const parts = [agency.tagline, agency.description]
    .map((p) => p?.replace(/\s+/g, ' ').trim() ?? '')
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.map((p, i) => (i < parts.length - 1 && !/[.!?…:;]$/.test(p) ? `${p}.` : p)).join(' ');
}

/** "Estate agency in Puerto" / "Property developer". */
export function portalAgencySubline(locale: string, agency: Pick<PortalAgencyProfile, 'kind' | 'city'>): string {
  const t = translator(locale, 'portal');
  const kind = t(`agency.kind.${agency.kind}`);
  return agency.city ? t('agency.kindIn', { kind, city: agency.city }) : kind;
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A place with its ancestors (country first): a listing's or development's breadcrumb trail. */
export interface PortalPlaceTrail {
  place: PortalPlace;
  ancestors: readonly PortalPlace[];
}

/**
 * A portal page as its SEO needs it: what the page's reads loaded, its locale and the portal's origin. `place` (the
 * listing's or development's deepest place with its ancestors) is needed for breadcrumbs only.
 */
export type PortalPage = { locale: string; origin: string } & (
  | { kind: 'home' }
  | { kind: 'search'; query: PortalQuery }
  | {
      kind: 'location';
      query: PortalQuery;
      location: PortalLocation;
      /** The location's slugs in each locale (`portalLocationPaths`). */
      slugs: Readonly<Record<string, readonly string[]>>;
    }
  | {
      kind: 'zone';
      query: PortalQuery;
      zone: PortalZone;
      /** The zone's slug in each locale (`portalZoneSlugs`). */
      slugs: Readonly<Record<string, string>>;
    }
  | { kind: 'agency'; query: PortalQuery; agency: PortalAgencyProfile }
  | { kind: 'listing'; listing: PortalListing; place?: PortalPlaceTrail | null }
  | { kind: 'development'; development: PortalDevelopment; place?: PortalPlaceTrail | null }
);

/** A page's metadata: the shape of Next's `Metadata` the portal fills (framework-free; the page returns it as is). */
export interface PortalMetadata {
  title: string;
  description: string;
  alternates: { canonical: string; languages: Record<string, string> };
  robots?: { index: boolean; follow: boolean };
  openGraph: {
    type: 'website';
    url: string;
    title: string;
    description: string;
    locale: string;
    images?: { url: string; alt?: string }[];
  };
  twitter?: { card: 'summary' | 'summary_large_image'; title: string };
}

const tOf = (locale: string) => translator(locale, 'portal');

/** Media CDN variant for Open Graph (1200 px), else the largest one. */
const ogImage = (urls: Partial<Record<string, string>>) => urls.og ?? urls.large ?? urls.medium ?? null;

const priceText = (
  locale: string,
  price: { onRequest: boolean; amountCents: number | null; currency: string },
): string =>
  price.onRequest || price.amountCents === null
    ? tOf(locale)('card.onRequest')
    : formatter(locale).money(price.amountCents, price.currency);

/** An absolute profile URL of the listing agency (JSON-LD). */
const agencyUrl = (origin: string, locale: string, a: PortalAgency) => `${origin}${agencyPath(locale, a.id, a.name)}`;

const allPaths = (pathOf: (locale: string) => string) => Object.fromEntries(UI_LOCALES.map((l) => [l, pathOf(l)]));

/** Every locale's path of a search-like page (no query). */
function searchLikePaths(page: Extract<PortalPage, { query: PortalQuery }>): Record<string, string> {
  switch (page.kind) {
    case 'search':
      return allPaths((l) => searchPath(l));
    case 'location':
      return Object.fromEntries(Object.entries(page.slugs).map(([l, p]) => [l, searchPath(l, p)]));
    case 'zone':
      return Object.fromEntries(Object.entries(page.slugs).map(([l, s]) => [l, zonePath(l, s)]));
    case 'agency':
      return page.agency.paths;
  }
}

/** The page's own path in its locale (a search-like page's without its query). */
function pathOf(page: PortalPage): string {
  switch (page.kind) {
    case 'home':
      return homePath(page.locale);
    case 'search':
      return searchPath(page.locale);
    case 'location':
      return searchPath(page.locale, page.location.place.path);
    case 'zone':
      return zonePath(page.locale, page.zone.slug);
    case 'agency':
      return page.agency.paths[page.locale] as string;
    case 'listing':
      return page.listing.paths[page.locale] as string;
    case 'development':
      return page.development.paths[page.locale] as string;
  }
}

/**
 * A search page's metadata (S15-01): canonical (its numbered page, or the filtered URL spelled one way), hreflang to
 * the same page in each locale, Open Graph. Filtered searches are `noindex, follow` (the location pages and their
 * numbered pages are what crawlers index); numbered pages index as themselves.
 */
function searchMetadata(input: {
  origin: string;
  locale: string;
  paths: Readonly<Record<string, string>>;
  query: PortalQuery;
  title: string;
  description: string;
}): PortalMetadata {
  const filtered = portalQueryHasFilters(input.query);
  const qs = portalQueryString(input.query);
  const withQuery = Object.fromEntries(Object.entries(input.paths).map(([l, p]) => [l, `${p}${qs}`]));
  const canonical = `${input.origin}${withQuery[input.locale] ?? ''}`;
  return {
    title: input.title,
    description: input.description,
    alternates: {
      canonical,
      languages: languageAlternates(input.origin, withQuery, DEFAULT_UI_LOCALE),
    },
    robots: filtered ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: {
      type: 'website',
      url: canonical,
      title: input.title,
      description: input.description,
      locale: input.locale,
    },
    twitter: { card: 'summary', title: input.title },
  };
}

/** "<title>, page N" past the first page. */
function paged(locale: string, query: PortalQuery, title: string): string {
  const page = query.page ?? 1;
  return page > 1 ? `${title}, ${tOf(locale)('search.pageSuffix', { page })}` : title;
}

/** The title pages show a listing under ("<Type> in <Town>"). */
export const portalPageTitle = (page: Extract<PortalPage, { kind: 'listing' | 'development' }>): string =>
  page.kind === 'listing'
    ? portalListingTitle(page.locale, page.listing.detail)
    : developmentNameOf(page.development.detail);

/**
 * A page's `generateMetadata` answer (PATTERNS §19): title, description, canonical, hreflang (with `x-default`),
 * robots (search-like pages), Open Graph and Twitter card. Every portal page's, from data only.
 */
export function portalMetadataFor(page: PortalPage): PortalMetadata {
  const { locale, origin } = page;
  const t = tOf(locale);
  switch (page.kind) {
    case 'home': {
      const url = `${origin}${homePath(locale)}`;
      return {
        title: t('home.title'),
        description: t('home.metaDescription'),
        alternates: {
          canonical: url,
          languages: languageAlternates(origin, allPaths(homePath), DEFAULT_UI_LOCALE),
        },
        openGraph: {
          type: 'website',
          url,
          title: t('home.title'),
          description: t('home.metaDescription'),
          locale,
        },
      };
    }
    case 'search':
    case 'location':
    case 'zone':
    case 'agency': {
      let title: string;
      let description: string;
      if (page.kind === 'search') {
        title = t('search.titleAll');
        description = t('search.metaDescriptionAll');
      } else if (page.kind === 'agency') {
        title = t('agency.metaTitle', { agency: page.agency.name });
        const summary = portalProfileSummary(page.agency);
        description = summary
          ? excerpt(summary, 160)
          : t('agency.metaDescription', { agency: page.agency.name, kind: portalAgencySubline(locale, page.agency) });
      } else {
        const place = page.kind === 'location' ? page.location.place.name : page.zone.name;
        title = t('search.titlePlace', { place });
        description = t('search.metaDescriptionPlace', { place });
      }
      return searchMetadata({
        origin,
        locale,
        paths: searchLikePaths(page),
        query: page.query,
        title: paged(locale, page.query, title),
        description,
      });
    }
    case 'listing': {
      const { detail, paths } = page.listing;
      const title = portalPageTitle(page);
      const metaTitle = t('listing.metaTitle', {
        type: detail.propertyType.name,
        town: townOf(detail.place),
        price: priceText(locale, detail.price),
      });
      const description = detail.metaDescription ?? (detail.description ? excerpt(detail.description, 160) : title);
      const image = detail.cover ? ogImage(detail.cover.urls) : null;
      const canonical = `${origin}${paths[locale]}`;
      return {
        title: metaTitle,
        description,
        alternates: { canonical, languages: languageAlternates(origin, paths, DEFAULT_UI_LOCALE) },
        openGraph: {
          type: 'website',
          url: canonical,
          title,
          description,
          locale,
          ...(image ? { images: [{ url: image, alt: title }] } : {}),
        },
        twitter: { card: image ? 'summary_large_image' : 'summary', title },
      };
    }
    case 'development': {
      const { detail, paths } = page.development;
      const name = portalPageTitle(page);
      const town = townOf(detail.place);
      const canonical = `${origin}${paths[locale]}`;
      const title = t('development.metaTitle', { name, town });
      const description =
        detail.metaDescription ??
        (detail.price.fromCents === null
          ? detail.description
            ? excerpt(detail.description, 160)
            : title
          : t('development.metaDescription', {
              town,
              units: detail.units.available,
              price: formatter(locale).money(detail.price.fromCents, detail.price.currency),
            }));
      return {
        title,
        description,
        alternates: { canonical, languages: languageAlternates(origin, paths, DEFAULT_UI_LOCALE) },
        openGraph: { type: 'website', url: canonical, title, description, locale },
        twitter: { card: 'summary', title },
      };
    }
  }
}

/** A page's breadcrumbs (its JSON-LD `BreadcrumbList` and the trail it shows): home first, the page itself last. */
export function portalCrumbs(page: PortalPage): Crumb[] {
  const { locale } = page;
  const t = tOf(locale);
  const home: Crumb = { name: t('breadcrumb.home'), path: homePath(locale) };
  const all: Crumb = { name: t('breadcrumb.all'), path: searchPath(locale) };
  const trail = (p: PortalPlaceTrail | null | undefined): Crumb[] =>
    p ? [...p.ancestors, p.place].map((x) => ({ name: x.name, path: searchPath(locale, x.path) })) : [];
  const path = pathOf(page);
  switch (page.kind) {
    case 'home':
      return [home];
    case 'search':
      return [home, { name: t('breadcrumb.all'), path }];
    case 'location':
      return [
        home,
        all,
        ...page.location.ancestors.map((a) => ({ name: a.name, path: searchPath(locale, a.path) })),
        { name: page.location.place.name, path },
      ];
    case 'zone':
      return [home, all, { name: page.zone.name, path }];
    case 'agency':
      return [home, { name: page.agency.name, path }];
    case 'listing':
    case 'development':
      return [home, all, ...trail(page.place), { name: portalPageTitle(page), path }];
  }
}

const placeAddress = (place: {
  city?: { name: string } | null;
  region?: { name: string } | null;
  country?: { name: string } | null;
}) => ({
  locality: place.city?.name ?? null,
  region: place.region?.name ?? null,
  country: place.country?.name ?? null,
});

/**
 * A page's structured data, in the order the page inlines it: the listing (`RealEstateListing`), the development
 * (`RealEstateListing` + `AggregateOffer`) or the agency (`RealEstateAgent`) first, then its `BreadcrumbList`. The home
 * page has none. Inline each with `serializeJsonLd`.
 */
export function portalJsonLd(page: PortalPage): object[] {
  const { locale, origin } = page;
  const crumbs = breadcrumbJsonLd(origin, portalCrumbs(page));
  const url = `${origin}${pathOf(page)}`;
  switch (page.kind) {
    case 'home':
      return [];
    case 'search':
    case 'location':
    case 'zone':
      return [crumbs];
    case 'agency': {
      const a = page.agency;
      return [
        agencyJsonLd({
          url,
          name: a.name,
          description: a.tagline ?? (a.description ? excerpt(a.description, 500) : null),
          email: a.email,
          telephone: a.phone,
          website: safeHttpUrl(a.website),
          city: a.city,
          languages: a.languages,
          registerNumber: a.registerNumber,
        }),
        crumbs,
      ];
    }
    case 'listing': {
      const { listing } = page;
      const { detail } = listing;
      const images = [detail.cover, ...detail.media]
        .flatMap((m) => (m && m.kind === 'IMAGE' ? [ogImage(m.urls)] : []))
        .filter((u): u is string => u !== null);
      return [
        listingJsonLd({
          url,
          name: portalPageTitle(page),
          description: detail.description ? excerpt(detail.description, 500) : null,
          images: [...new Set(images)].slice(0, 5),
          price:
            detail.price.onRequest || detail.price.amountCents === null
              ? null
              : { amount: detail.price.amountCents / 100, currency: detail.price.currency },
          bedrooms: detail.bedrooms,
          bathrooms: detail.bathrooms,
          builtM2: detail.builtM2,
          address: placeAddress(detail.place),
          geo: detail.geo ? { lat: detail.geo.lat, lng: detail.geo.lng } : null,
          agency: listing.agency ? { name: listing.agency.name, url: agencyUrl(origin, locale, listing.agency) } : null,
          dateModified: listing.updatedAt.toISOString(),
        }),
        crumbs,
      ];
    }
    case 'development': {
      const { development } = page;
      const { detail } = development;
      return [
        developmentJsonLd({
          url,
          name: portalPageTitle(page),
          description: detail.description ? excerpt(detail.description, 500) : null,
          price:
            detail.price.fromCents === null
              ? null
              : {
                  low: detail.price.fromCents / 100,
                  high: (detail.price.toCents ?? detail.price.fromCents) / 100,
                  currency: detail.price.currency,
                },
          available: detail.units.available,
          address: placeAddress(detail.place),
          geo: detail.geo ? { lat: detail.geo.lat, lng: detail.geo.lng } : null,
          agency: development.agency
            ? { name: development.agency.name, url: agencyUrl(origin, locale, development.agency) }
            : null,
          dateModified: development.updatedAt.toISOString(),
        }),
        crumbs,
      ];
    }
  }
}
