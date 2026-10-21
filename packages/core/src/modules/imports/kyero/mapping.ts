import type { FeedListingInput } from '@inmolink/contracts';
import { MEDIA_PER_LISTING_MAX } from '@inmolink/contracts';
import { childOf, childText, type XmlElement } from '@inmolink/platform/xml';
import { formatDefaults } from '../config';
import type { FeedItemProblem, MapResult } from '../connectors';
import { htmlToPlainText } from '../html';
import { clip, decimal, integer, positive, priceToCents, rating, truthy } from '../values';

/**
 * Kyero v3 `<property>` → the loader's `FeedListing` (S6-03). Pure: no I/O. `coverage.ts` lists every element and
 * where it goes; this file is that table as code. Taxonomy values stay the feed's text (resolved by the loader).
 */
export interface KyeroSettings {
  /** Country for feeds that do not send one (Kyero v3 has none). */
  defaultCountry: string;
  /** Locale of the generated title when the feed has no description at all. */
  defaultLocale: string;
  /** Currency of a price without `<currency>`. */
  defaultCurrency: string;
}

/** The connection's settings over Kyero's defaults (`FORMAT_DEFAULTS`, S7-F2). */
export function kyeroSettings(settings: Record<string, unknown>): KyeroSettings {
  const d = formatDefaults('kyero', settings);
  return { defaultCountry: d.country, defaultLocale: d.locale, defaultCurrency: d.currency };
}

const problem = (code: string, field: string, message?: string): FeedItemProblem => ({
  code,
  field,
  ...(message ? { message } : {}),
});

/** Language elements below `parent` (`<desc><en>..</en><es>..</es></desc>`): locale (lower-case, 2 letters) → text. */
function perLanguage(parent: XmlElement | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const el of parent?.children ?? []) {
    const locale = el.name.toLowerCase();
    const text = el.text.trim();
    if (/^[a-z]{2}$/.test(locale) && text && !out.has(locale)) out.set(locale, text);
  }
  return out;
}

export function mapKyeroProperty(raw: XmlElement, settings: KyeroSettings): MapResult<FeedListingInput> {
  const ref = childText(raw, 'id') ?? childText(raw, 'ref');
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'id', 'a property needs an id or ref')] };
  const problems: FeedItemProblem[] = [];

  // price / frequency → transaction
  const freq = (childText(raw, 'price_freq') ?? 'sale').toLowerCase();
  let transactionType: FeedListingInput['transactionType'] = 'SALE';
  let pricePeriod: FeedListingInput['pricePeriod'] = null;
  if (freq === 'month') {
    transactionType = 'RENT_LONG_TERM';
    pricePeriod = 'MONTH';
  } else if (freq === 'week') {
    transactionType = 'RENT_SHORT_TERM';
    pricePeriod = 'WEEK';
  } else if (freq !== 'sale') {
    problems.push(problem('INVALID_FIELD', 'price_freq', 'expected sale, month or week'));
  }
  const priceText = childText(raw, 'price');
  let priceCents: number | null = null;
  if (priceText !== undefined) {
    priceCents = priceToCents(priceText);
    if (priceCents === null) problems.push(problem('INVALID_PRICE', 'price', 'a decimal number without separators'));
  }
  const priceOnRequest = priceCents === null || priceCents === 0;
  if (priceCents === 0) priceCents = null;
  const currency = (childText(raw, 'currency') ?? settings.defaultCurrency).toUpperCase();

  // coordinates
  const loc = childOf(raw, 'location');
  const lat = decimal(loc ? childText(loc, 'latitude') : undefined);
  const lng = decimal(loc ? childText(loc, 'longitude') : undefined);
  const coordinates =
    lat !== null && lng !== null && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng }
      : null;

  // taxonomy
  const type = childText(raw, 'type');
  const town = childText(raw, 'town');
  const location: NonNullable<FeedListingInput['location']> = {
    country: childText(raw, 'country') ?? settings.defaultCountry,
    ...(childText(raw, 'province') ? { region: childText(raw, 'province') } : {}),
    ...(town ? { city: town } : {}),
    ...(childText(raw, 'location_detail') ? { area: childText(raw, 'location_detail') } : {}),
  };
  if (!type) problems.push(problem('MISSING_FIELD', 'type', 'the property type is required'));

  const features: string[] = [];
  const seen = new Set<string>();
  const addFeature = (text: string) => {
    const t = text.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      features.push(t);
    }
  };
  if (truthy(childText(raw, 'pool'))) addFeature('Pool');
  for (const f of childOf(raw, 'features')?.children ?? []) if (f.name === 'feature') addFeature(f.text);

  // translations: a description per language (HTML to text), a title from the data unless the feed has one
  const descriptions = perLanguage(childOf(raw, 'desc'));
  const titles = perLanguage(childOf(raw, 'title'));
  const generated = clip([type, town].filter(Boolean).join(', ') || ref, 200);
  const locales = new Set([...descriptions.keys(), ...titles.keys()]);
  if (locales.size === 0) locales.add(settings.defaultLocale);
  const translations = [...locales].map((locale) => {
    const description = descriptions.get(locale);
    const text = description ? htmlToPlainText(description) : '';
    const title = titles.get(locale) ? htmlToPlainText(titles.get(locale) as string, 200) : '';
    return { locale, title: title || generated, description: text || null };
  });

  const images: string[] = [];
  for (const image of childOf(raw, 'images')?.children ?? []) {
    const url = image.name === 'image' ? childText(image, 'url') : undefined;
    if (url && /^https?:\/\/\S+$/i.test(url) && images.length < MEDIA_PER_LISTING_MAX) images.push(url);
  }

  const area = childOf(raw, 'surface_area');
  const energy = childOf(raw, 'energy_rating');

  if (problems.length > 0) return { ok: false, ref, problems };
  return {
    ok: true,
    ref,
    item: {
      ref,
      transactionType,
      pricePeriod,
      priceCents,
      priceOnRequest,
      currency,
      builtM2: area ? positive(childText(area, 'built')) : null,
      plotM2: area ? positive(childText(area, 'plot')) : null,
      bedrooms: integer(childText(raw, 'beds')),
      bathrooms: integer(childText(raw, 'baths')),
      energyRating: energy ? rating(childText(energy, 'consumption')) : null,
      energyEmissionsRating: energy ? rating(childText(energy, 'emissions')) : null,
      coordinates,
      locationPrecision: 'APPROX',
      propertyType: type as string,
      location,
      features,
      translations,
      images,
    },
  };
}
