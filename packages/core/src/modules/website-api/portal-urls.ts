/**
 * The portal's URL shapes (S15-01, moved to core in S15-02): the pages (`apps/public`), their canonicals and hreflang,
 * the sitemaps (a worker job) and the legacy redirects all build portal paths here, so they cannot disagree. Pure.
 *
 * - `/{locale}/properties` — every listing; `/{locale}/properties/{country}/{region}/{city}/{area}` — a location page
 * - `/{locale}/zone/{slug}` — a location group (a comarca, a coast)
 * - `/{locale}/property/{type-in-town}-{code}` — a listing (its public code, lower case)
 * - `/{locale}/development/{name}-{code}` — a new-build development with its units (its public code, lower case)
 * - `/{locale}/agency/{agencyId}/{name}` — a listed agency's profile with its PUBLIC listings (S15-03)
 */
import { translator } from '@inmolink/i18n/server';
import { slugOf } from '../websites';

export const homePath = (locale: string) => `/${locale}`;
export const searchPath = (locale: string, placePath: readonly string[] = []) =>
  ['', locale, 'properties', ...placePath.map(encodeURIComponent)].join('/');
export const zonePath = (locale: string, slug: string) => `/${locale}/zone/${encodeURIComponent(slug)}`;
export const listingPath = (locale: string, title: string, code: string) =>
  `/${locale}/property/${slugOf(title, 'property')}-${code.toLowerCase()}`;
export const developmentPath = (locale: string, name: string, code: string) =>
  `/${locale}/development/${slugOf(name, 'development')}-${code.toLowerCase()}`;
/** S15-03: a listed agency's profile page (its id names it; the name slug follows a rename — the page 301s to it). */
export const agencyPath = (locale: string, id: string, name: string) =>
  `/${locale}/agency/${id.toLowerCase()}/${slugOf(name, 'agency')}`;

/** A card's or listing's place as the portal names its town. */
export interface PortalPlaceNames {
  country?: { name: string } | null;
  region?: { name: string } | null;
  city?: { name: string } | null;
  area?: { name: string } | null;
}

/** The town a card names: the city, else the area, else the region, else the country. */
export const townOf = (place: PortalPlaceNames) =>
  place.city?.name ?? place.area?.name ?? place.region?.name ?? place.country?.name ?? '';

/**
 * "<Type> in <Town>" in `locale` (`portal.card.title`): every listing page is titled — and its URL slugged — from data,
 * never from the owner's headline. The pages use the same message through next-intl.
 */
export function portalListingTitle(
  locale: string,
  doc: { propertyType: { name: string }; place: PortalPlaceNames },
): string {
  return translator(locale, 'portal')('card.title', { type: doc.propertyType.name, town: townOf(doc.place) });
}

/** The development's name as pages title it (the developer's name; its marketing title when it has none). */
export const developmentNameOf = (d: { name: string; title: string }) => d.name || d.title;

/**
 * An agency- or agent-supplied URL the portal may link to: absolute `http:` / `https:` only (a `javascript:`, `data:`
 * or relative value is never rendered as a link — defence in depth beside the profile's own input check). Null: no
 * link. S15-F7: here, so the page's JSON-LD (`portal-seo.ts`) and its views read one rule.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
