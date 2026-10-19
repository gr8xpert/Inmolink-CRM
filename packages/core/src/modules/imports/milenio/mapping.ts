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
 * Milenio+ `<inmueble>` to the loader's `FeedListing` (S6-07). Pure. The element names are ASSUMED (no public
 * specification; confirm with a real export at H14): see `coverage.ts`. Owner, commission and internal notes are
 * never read.
 */
export function mapMilenioInmueble(raw: XmlElement, settings: FormatSettings): MapResult<FeedListingInput> {
  const ref = childText(raw, 'referencia');
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'referencia', 'a property needs a reference')] };
  const problems: FeedItemProblem[] = [];

  const operation = (childText(raw, 'operacion') ?? '').toLowerCase();
  let transactionType: FeedListingInput['transactionType'] = 'SALE';
  let pricePeriod: FeedListingInput['pricePeriod'] = null;
  if (/^alquiler (vacacional|de temporada|temporada)$/.test(operation)) {
    transactionType = 'RENT_SHORT_TERM';
    pricePeriod = /noche/i.test(childText(raw, 'periodo') ?? '') ? 'NIGHT' : 'WEEK';
  } else if (operation === 'alquiler') {
    transactionType = 'RENT_LONG_TERM';
    pricePeriod = 'MONTH';
  } else if (operation !== 'venta') {
    problems.push(problem('INVALID_FIELD', 'operacion', 'expected venta, alquiler or alquiler vacacional'));
  }
  const { priceCents, priceOnRequest } = priceFields(
    childText(raw, 'precio'),
    localizedPriceToCents,
    problems,
    'precio',
  );
  const currency = currencyOf(childText(raw, 'moneda'));

  const state = (childText(raw, 'estado') ?? '').toLowerCase();
  let status: FeedListingInput['status'] = 'ACTIVE';
  if (state === 'reservado') status = 'UNDER_OFFER';
  else if (state === 'vendido' && transactionType === 'SALE') status = 'SOLD';
  else if (state === 'alquilado' && transactionType !== 'SALE') status = 'RENTED';

  const type = childText(raw, 'tipo');
  if (!type) problems.push(problem('MISSING_FIELD', 'tipo', 'the property type is required'));
  const city = childText(raw, 'localidad');
  const region = childText(raw, 'provincia');
  const area = childText(raw, 'zona');
  const location: NonNullable<FeedListingInput['location']> = {
    country: childText(raw, 'pais') ?? settings.defaultCountry,
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(area ? { area } : {}),
  };

  const titles = new PerLocale();
  for (const t of childOf(raw, 'titulos')?.children ?? [])
    if (t.name === 'titulo') titles.add(localeOf(t.attributes.idioma), t.text);
  const descriptions = new PerLocale();
  for (const d of childOf(raw, 'descripciones')?.children ?? [])
    if (d.name === 'descripcion') descriptions.add(localeOf(d.attributes.idioma), d.text);

  const photos = (childOf(raw, 'fotos')?.children ?? [])
    .filter((f) => f.name === 'foto')
    .map((f, i) => ({ i, order: integer(f.attributes.orden) ?? Number.MAX_SAFE_INTEGER, url: f.text }))
    .sort((a, b) => a.order - b.order || a.i - b.i);

  const energy = childOf(raw, 'certificacion_energetica');
  const features = uniqueTexts(
    (childOf(raw, 'caracteristicas')?.children ?? []).filter((c) => c.name === 'caracteristica').map((c) => c.text),
  );

  return finishListing(ref, problems, {
    ref,
    transactionType,
    status,
    pricePeriod,
    priceCents,
    priceOnRequest,
    currency,
    builtM2: localizedPositive(childText(raw, 'm2_construidos')),
    plotM2: localizedPositive(childText(raw, 'm2_parcela')),
    terraceM2: localizedPositive(childText(raw, 'm2_terraza')),
    bedrooms: integer(childText(raw, 'habitaciones')),
    bathrooms: integer(childText(raw, 'banos')),
    yearBuilt: year(childText(raw, 'anio_construccion')),
    energyRating: energy ? rating(childText(energy, 'consumo')) : null,
    energyEmissionsRating: energy ? rating(childText(energy, 'emisiones')) : null,
    coordinates: point(childText(raw, 'latitud'), childText(raw, 'longitud')),
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
    images: httpImages(photos.map((p) => p.url)),
  });
}
