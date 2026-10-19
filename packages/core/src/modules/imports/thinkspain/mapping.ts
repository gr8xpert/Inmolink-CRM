import type { FeedListingInput } from '@inmolink/contracts';
import { childOf, childText, type XmlElement } from '@inmolink/platform/xml';
import {
  buildTranslations,
  currencyOf,
  type FormatSettings,
  finishListing,
  generatedTitle,
  httpImages,
  localeOf,
  PerLocale,
  point,
  priceFields,
  problem,
  uniqueTexts,
} from '../assemble';
import type { FeedItemProblem, MapResult } from '../connectors';
import { integer, positive, priceToCents, rating, year } from '../values';

/**
 * thinkSPAIN `<property>` to the loader's `FeedListing` (S6-07). Pure. The element names are ASSUMED (the
 * specification is not public; confirm with a real sample at H14): see `coverage.ts`. Agent contact is never read.
 */
export function mapThinkSpainProperty(raw: XmlElement, settings: FormatSettings): MapResult<FeedListingInput> {
  const ref = childText(raw, 'reference');
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'reference', 'a property needs a reference')] };
  const problems: FeedItemProblem[] = [];

  const kind = (childText(raw, 'listing_type') ?? 'sale').toLowerCase();
  let transactionType: FeedListingInput['transactionType'] = 'SALE';
  let pricePeriod: FeedListingInput['pricePeriod'] = null;
  if (kind === 'rent') {
    transactionType = 'RENT_LONG_TERM';
    pricePeriod = 'MONTH';
  } else if (kind === 'holiday_rent') {
    transactionType = 'RENT_SHORT_TERM';
    pricePeriod = /night/i.test(childText(raw, 'price_period') ?? '') ? 'NIGHT' : 'WEEK';
  } else if (kind !== 'sale') {
    problems.push(problem('INVALID_FIELD', 'listing_type', 'expected sale, rent or holiday_rent'));
  }
  const { priceCents, priceOnRequest } = priceFields(childText(raw, 'price'), priceToCents, problems, 'price');
  const currency = currencyOf(childText(raw, 'currency'));

  const state = (childText(raw, 'status') ?? '').toLowerCase();
  let status: FeedListingInput['status'] = 'ACTIVE';
  if (state === 'reserved') status = 'UNDER_OFFER';
  else if (state === 'sold' && transactionType === 'SALE') status = 'SOLD';
  else if (state === 'rented' && transactionType !== 'SALE') status = 'RENTED';

  const type = childText(raw, 'type');
  if (!type) problems.push(problem('MISSING_FIELD', 'type', 'the property type is required'));
  const city = childText(raw, 'town');
  const region = childText(raw, 'province');
  const area = childText(raw, 'area');
  const location: NonNullable<FeedListingInput['location']> = {
    country: childText(raw, 'country') ?? settings.defaultCountry,
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(area ? { area } : {}),
  };

  const titles = new PerLocale();
  const descriptions = new PerLocale();
  for (const el of raw.children) {
    if (el.name === 'title') titles.add(localeOf(el.attributes.lang), el.text);
    else if (el.name === 'description') descriptions.add(localeOf(el.attributes.lang), el.text);
  }

  return finishListing(ref, problems, {
    ref,
    transactionType,
    status,
    pricePeriod,
    priceCents,
    priceOnRequest,
    currency,
    builtM2: positive(childText(raw, 'built_size')),
    plotM2: positive(childText(raw, 'plot_size')),
    terraceM2: positive(childText(raw, 'terrace_size')),
    bedrooms: integer(childText(raw, 'bedrooms')),
    bathrooms: integer(childText(raw, 'bathrooms')),
    yearBuilt: year(childText(raw, 'year_built')),
    energyRating: rating(childText(raw, 'energy_class')),
    energyEmissionsRating: rating(childText(raw, 'emissions_class')),
    coordinates: point(childText(raw, 'latitude'), childText(raw, 'longitude')),
    locationPrecision: 'APPROX',
    propertyType: type as string,
    location,
    features: uniqueTexts(
      (childOf(raw, 'features')?.children ?? []).filter((f) => f.name === 'feature').map((f) => f.text),
    ),
    translations: buildTranslations(
      titles.map,
      descriptions.map,
      generatedTitle(ref, type, city),
      settings.defaultLocale,
    ),
    images: httpImages((childOf(raw, 'photos')?.children ?? []).filter((p) => p.name === 'photo').map((p) => p.text)),
  });
}
