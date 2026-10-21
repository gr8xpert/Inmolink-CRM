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
import { integer, positive, priceToCents, truthy, year } from '../values';

/**
 * Inmoba (Inmobalia CRM) `<property>` to the loader's `FeedListing` (S6-07). Pure. `coverage.ts` is the field table.
 * One property can be for sale and for rent at once; a listing has one transaction type, so a sale wins, then a
 * long-term rental, then a short-term one (recorded in STATUS, S6-07 decisions).
 */

const no = (text: string | undefined) => text === undefined || /^(no|none|ninguno|-)$/i.test(text.trim());

function price(
  raw: XmlElement,
  main: string,
  fallback: string,
  defaultCurrency: string,
): { text: string | undefined; currency: string } {
  const el = childOf(raw, main);
  const text = childText(raw, main) ?? childText(raw, fallback);
  return { text, currency: currencyOf(el?.attributes.currency, defaultCurrency) };
}

export function mapInmobaProperty(raw: XmlElement, settings: FormatSettings): MapResult<FeedListingInput> {
  const ref = childText(raw, 'reference');
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'reference', 'a property needs a reference')] };
  const problems: FeedItemProblem[] = [];

  const forSale = truthy(childText(raw, 'is_for_sale'));
  const rentLong = truthy(childText(raw, 'is_for_rent_long'));
  const rentShort = truthy(childText(raw, 'is_for_rent_short'));
  const rent = truthy(childText(raw, 'is_for_rent'));
  let transactionType: FeedListingInput['transactionType'] = 'SALE';
  let pricePeriod: FeedListingInput['pricePeriod'] = null;
  let chosen = price(raw, 'selling_price', 'selling_price_eur', settings.defaultCurrency);
  if (!forSale) {
    if (rentLong || (rent && !rentShort)) {
      transactionType = 'RENT_LONG_TERM';
      pricePeriod = 'MONTH';
      chosen = price(raw, 'rental_price_long', 'rental_price_eur_long', settings.defaultCurrency);
    } else if (rentShort || rent) {
      transactionType = 'RENT_SHORT_TERM';
      pricePeriod = /night|noche/i.test(childText(raw, 'rental_price_comment') ?? '') ? 'NIGHT' : 'WEEK';
      chosen = price(raw, 'rental_price', 'rental_price_eur', settings.defaultCurrency);
    } else {
      problems.push(problem('INVALID_FIELD', 'is_for_sale', 'the property is neither for sale nor for rent'));
    }
  }
  const { priceCents, priceOnRequest } = priceFields(chosen.text, priceToCents, problems, 'price');
  const status: FeedListingInput['status'] =
    transactionType === 'SALE'
      ? truthy(childText(raw, 'is_sold'))
        ? 'SOLD'
        : 'ACTIVE'
      : truthy(childText(raw, 'is_rented'))
        ? 'RENTED'
        : 'ACTIVE';

  const type = childText(raw, 'propertytype');
  if (!type) problems.push(problem('MISSING_FIELD', 'propertytype', 'the property type is required'));
  const city = childText(raw, 'cityname');
  const region = childText(raw, 'province');
  const area = childText(raw, 'subarea');
  const location: NonNullable<FeedListingInput['location']> = {
    country: childText(raw, 'country') ?? settings.defaultCountry,
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(area ? { area } : {}),
  };

  const features = uniqueTexts([
    ...(no(childText(raw, 'tr_pool')) ? [] : ['Pool']),
    ...(no(childText(raw, 'tr_garden')) ? [] : ['Garden']),
    ...(no(childText(raw, 'tr_garage')) ? [] : ['Garage']),
    ...(childOf(raw, 'options')?.children ?? []).filter((o) => o.name === 'option').map((o) => o.text),
  ]);

  const titles = new PerLocale();
  const descriptions = new PerLocale();
  for (const d of childOf(raw, 'descriptions')?.children ?? []) {
    if (d.name === 'short_description') titles.add(localeOf(d.attributes.lang), d.text);
    else if (d.name === 'long_description') descriptions.add(localeOf(d.attributes.lang), d.text);
  }

  const images = httpImages(
    (childOf(raw, 'images')?.children ?? []).filter((i) => i.name === 'image').map((i) => i.attributes.url),
  );

  return finishListing(ref, problems, {
    ref,
    transactionType,
    status,
    pricePeriod,
    priceCents,
    priceOnRequest,
    currency: chosen.currency,
    builtM2: positive(childText(raw, 'mts_build')),
    plotM2: positive(childText(raw, 'mts_plot')),
    terraceM2: positive(childText(raw, 'mts_terrace')),
    bedrooms: integer(childText(raw, 'nr_bedrooms')),
    bathrooms: integer(childText(raw, 'nr_bathrooms')),
    yearBuilt: year(childText(raw, 'dt_construction_year')),
    coordinates: point(childText(raw, 'latitude'), childText(raw, 'longitude')),
    locationPrecision: 'APPROX',
    propertyType: type as string,
    location,
    features,
    translations: buildTranslations(
      titles.map,
      descriptions.map,
      generatedTitle(ref, type, city),
      settings.defaultLocale,
    ),
    images,
  });
}
