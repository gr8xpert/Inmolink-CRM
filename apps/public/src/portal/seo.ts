/**
 * Structured data and alternates for portal pages (S15-01, PLAN §7 M14): JSON-LD made safe to inline, breadcrumbs and
 * the listing as schema.org `RealEstateListing`. Pure.
 */

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
  /** The listing agency; `url` its profile page (null until the profiles are live). */
  agency: { name: string; url: string | null } | null;
  dateModified: string;
}

/** A schema.org `RealEstateAgent` (its profile URL only when there is one). */
const agentLd = (a: { name: string; url: string | null }) => ({
  '@type': 'RealEstateAgent',
  name: a.name,
  ...(a.url ? { url: a.url } : {}),
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
  agency: { name: string; url: string | null } | null;
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

/** `alternates.languages` for `generateMetadata`: each locale's absolute URL, plus `x-default` (the default locale). */
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
