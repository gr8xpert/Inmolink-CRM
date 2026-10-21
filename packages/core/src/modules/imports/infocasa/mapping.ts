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
import { integer, localizedPositive, localizedPriceToCents, rating, year } from '../values';

/**
 * Infocasa `<propiedad>` to the loader's `FeedListing` (S6-07). Pure. The element names are ASSUMED (no public
 * specification; confirm with a real export at H14): see `coverage.ts`. Contact and private notes are never read.
 */
function perLanguage(parent: XmlElement | undefined): PerLocale {
  const out = new PerLocale();
  for (const el of parent?.children ?? []) out.add(localeOf(el.name), el.text);
  return out;
}

export function mapInfocasaPropiedad(raw: XmlElement, settings: FormatSettings): MapResult<FeedListingInput> {
  const ref = raw.attributes.id?.trim();
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'id', 'a property needs an id')] };
  const problems: FeedItemProblem[] = [];

  const action = (childText(raw, 'accion') ?? '').toUpperCase();
  let transactionType: FeedListingInput['transactionType'] = 'SALE';
  let pricePeriod: FeedListingInput['pricePeriod'] = null;
  if (action === 'A') {
    transactionType = 'RENT_LONG_TERM';
    pricePeriod = 'MONTH';
  } else if (action === 'T') {
    transactionType = 'RENT_SHORT_TERM';
    pricePeriod = /noche/i.test(childOf(raw, 'precio')?.attributes.periodo ?? '') ? 'NIGHT' : 'WEEK';
  } else if (action !== 'V') {
    problems.push(problem('INVALID_FIELD', 'accion', 'expected V, A or T'));
  }
  const priceEl = childOf(raw, 'precio');
  const { priceCents, priceOnRequest } = priceFields(
    childText(raw, 'precio'),
    localizedPriceToCents,
    problems,
    'precio',
  );
  const currency = currencyOf(priceEl?.attributes.moneda, settings.defaultCurrency);

  const state = (childText(raw, 'situacion') ?? '').toLowerCase();
  let status: FeedListingInput['status'] = 'ACTIVE';
  if (state === 'reservado') status = 'UNDER_OFFER';
  else if (state === 'vendido' && transactionType === 'SALE') status = 'SOLD';
  else if (state === 'alquilado' && transactionType !== 'SALE') status = 'RENTED';

  const type = childText(raw, 'tipo_inmueble');
  if (!type) problems.push(problem('MISSING_FIELD', 'tipo_inmueble', 'the property type is required'));
  const city = childText(raw, 'municipio');
  const region = childText(raw, 'provincia');
  const area = childText(raw, 'barrio');
  const location: NonNullable<FeedListingInput['location']> = {
    country: childText(raw, 'pais') ?? settings.defaultCountry,
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(area ? { area } : {}),
  };

  return finishListing(ref, problems, {
    ref,
    transactionType,
    status,
    pricePeriod,
    priceCents,
    priceOnRequest,
    currency,
    builtM2: localizedPositive(childText(raw, 'superficie_construida')),
    plotM2: localizedPositive(childText(raw, 'superficie_parcela')),
    terraceM2: localizedPositive(childText(raw, 'superficie_terraza')),
    bedrooms: integer(childText(raw, 'dormitorios')),
    bathrooms: integer(childText(raw, 'aseos')),
    yearBuilt: year(childText(raw, 'ano_construccion')),
    energyRating: rating(childText(raw, 'calificacion_energetica')),
    energyEmissionsRating: rating(childText(raw, 'emisiones_co2')),
    coordinates: point(childText(raw, 'lat'), childText(raw, 'lon')),
    locationPrecision: 'APPROX',
    propertyType: type as string,
    location,
    features: uniqueTexts(
      (childOf(raw, 'extras')?.children ?? []).filter((e) => e.name === 'extra').map((e) => e.text),
    ),
    translations: buildTranslations(
      perLanguage(childOf(raw, 'titulo')).map,
      perLanguage(childOf(raw, 'descripcion')).map,
      generatedTitle(ref, type, city),
      settings.defaultLocale,
    ),
    images: httpImages((childOf(raw, 'fotos')?.children ?? []).filter((f) => f.name === 'foto').map((f) => f.text)),
  });
}
