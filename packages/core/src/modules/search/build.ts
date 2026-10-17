/**
 * Read-model documents (S5-01, PATTERNS §14): pure functions from a listing's or unit's client-safe data to the
 * card and detail JSON of one content locale. Every field is copied by name into the strict shapes of
 * `@inmolink/contracts` (`ListingCardDoc`, `UnitDetailDoc`, …): nothing is spread from a source row, so a column
 * added to a source never reaches a public path unless it is named here.
 */
import { createHash } from 'node:crypto';
import type {
  ListingCardDoc,
  ListingDetailDoc,
  ReadModelImage,
  ReadModelMedia,
  ReadModelPlace,
  ReadModelTaxon,
  UnitCardDoc,
  UnitDetailDoc,
} from '@inmolink/contracts';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import type * as developments from '../developments';
import type * as media from '../media';
import type * as properties from '../properties';
import * as taxonomy from '../taxonomy';

export interface BuiltDoc {
  targetId: string;
  locale: string;
  kind: 'LISTING' | 'UNIT';
  agencyId: string;
  developmentId: string | null;
  public: boolean;
  status: string;
  version: number;
  card: ListingCardDoc | UnitCardDoc;
  detail: ListingDetailDoc | UnitDetailDoc;
  etag: string;
}

/** Strong ETag source: a hash of both documents (feed-api quotes it). */
export function etagOf(card: unknown, detail: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([card, detail]))
    .digest('base64url')
    .slice(0, 27);
}

/**
 * The text for `locale`: its own translation, else the fallback content locale's, else the first of the agency's
 * locales that has one, else any. `textLocale` names the locale used when it is not `locale`.
 */
export function pickText<T extends { locale: string }>(
  texts: readonly T[],
  locale: string,
  agencyLocales: readonly string[],
): { text: T; textLocale: string | null } | null {
  const by = new Map(texts.map((t) => [t.locale, t]));
  for (const l of [locale, FALLBACK_CONTENT_LOCALE, ...agencyLocales]) {
    const text = by.get(l);
    if (text) return { text, textLocale: l === locale ? null : l };
  }
  const first = texts[0];
  return first ? { text: first, textLocale: first.locale } : null;
}

const LEVELS = { COUNTRY: 'country', REGION: 'region', CITY: 'city', AREA: 'area' } as const;

function placeOf(tax: taxonomy.ReadModelTaxonomy, locationId: string, locale: string): ReadModelPlace {
  const place: ReadModelPlace = { country: null, region: null, city: null, area: null };
  for (const node of tax.lineage.get(locationId) ?? []) {
    place[LEVELS[node.level]] = taxonomy.taxonName(tax, node.id, locale);
  }
  return place;
}

/** A property type with no name in any locale (never in practice): its id, so the document stays valid. */
const taxonOf = (tax: taxonomy.ReadModelTaxonomy, id: string, locale: string): ReadModelTaxon =>
  taxonomy.taxonName(tax, id, locale) ?? { id, name: id, slug: id };

const geoOf = (lat: number | null, lng: number | null, precision: 'EXACT' | 'APPROX') =>
  lat === null || lng === null ? null : { lat, lng, precision };

/** The cover: the image marked so, else the first image. */
function coverOf(items: readonly ReadModelMedia[]): ReadModelImage | null {
  const images = items.filter((m): m is ReadModelImage => m.kind === 'IMAGE');
  return images.find((m) => m.cover) ?? images[0] ?? null;
}

export function buildListingDocs(
  l: properties.ReadModelListing,
  mediaSet: media.ReadModelMediaSet | undefined,
  tax: taxonomy.ReadModelTaxonomy,
  locales: readonly string[],
): BuiltDoc[] {
  const items = mediaSet?.items ?? [];
  const cover = coverOf(items);
  const imageCount = items.filter((m) => m.kind === 'IMAGE').length;
  return locales.map((locale) => {
    const picked = pickText(l.translations, locale, locales);
    const card: ListingCardDoc = {
      kind: 'LISTING',
      id: l.id,
      ref: l.ref,
      status: l.status,
      transactionType: l.transactionType,
      price: {
        amountCents: l.priceOnRequest ? null : l.priceCents,
        currency: l.currency,
        period: l.pricePeriod,
        onRequest: l.priceOnRequest,
      },
      propertyType: taxonOf(tax, l.propertyTypeId, locale),
      place: placeOf(tax, l.locationId, locale),
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      builtM2: l.builtM2,
      plotM2: l.plotM2,
      geo: geoOf(l.lat, l.lng, l.locationPrecision),
      cover,
      imageCount,
      developmentId: l.developmentId,
      title: picked?.text.title ?? l.ref,
      slug: picked?.text.slug ?? l.id,
      textLocale: picked?.textLocale ?? null,
    };
    const detail: ListingDetailDoc = {
      ...card,
      description: picked?.text.description ?? null,
      metaTitle: picked?.text.metaTitle ?? null,
      metaDescription: picked?.text.metaDescription ?? null,
      terraceM2: l.terraceM2,
      yearBuilt: l.yearBuilt,
      energyRating: l.energyRating,
      energyEmissionsRating: l.energyEmissionsRating,
      features: l.featureIds.map((id) => taxonOf(tax, id, locale)),
      media: items,
    };
    return {
      targetId: l.id,
      locale,
      kind: 'LISTING',
      agencyId: l.agencyId,
      developmentId: l.developmentId,
      public: l.visibility === 'PUBLIC',
      status: l.status,
      version: l.version,
      card,
      detail,
      etag: etagOf(card, detail),
    };
  });
}

export function buildUnitDocs(
  u: developments.ReadModelUnit,
  tax: taxonomy.ReadModelTaxonomy,
  locales: readonly string[],
): BuiltDoc[] {
  const d = u.development;
  return locales.map((locale) => {
    const picked = pickText(d.translations, locale, locales);
    const card: UnitCardDoc = {
      kind: 'UNIT',
      id: u.id,
      ref: u.ref,
      status: u.status,
      price: { amountCents: u.priceCents, currency: u.currency, period: null, onRequest: u.priceCents === null },
      propertyType: taxonOf(tax, u.propertyTypeId, locale),
      place: placeOf(tax, d.locationId, locale),
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      internalM2: u.internalM2,
      terraceM2: u.terraceM2,
      plotM2: u.plotM2,
      floor: u.floor,
      orientation: u.orientation,
      // A building site: its shown point is the development's own.
      geo: geoOf(d.lat, d.lng, 'EXACT'),
      development: { id: u.developmentId, name: d.name, status: d.status, completionDate: d.completionDate },
      title: picked?.text.title ?? d.name,
      slug: picked?.text.slug ?? u.developmentId,
      textLocale: picked?.textLocale ?? null,
    };
    const detail: UnitDetailDoc = {
      ...card,
      description: picked?.text.description ?? null,
      paymentTerms: picked?.text.paymentTerms ?? null,
      metaTitle: picked?.text.metaTitle ?? null,
      metaDescription: picked?.text.metaDescription ?? null,
      phase: u.phase ? { name: u.phase.name, status: u.phase.status, completionDate: u.phase.completionDate } : null,
    };
    return {
      targetId: u.id,
      locale,
      kind: 'UNIT',
      agencyId: u.agencyId,
      developmentId: u.developmentId,
      public: d.open,
      status: u.status,
      version: u.version,
      card,
      detail,
      etag: etagOf(card, detail),
    };
  });
}
