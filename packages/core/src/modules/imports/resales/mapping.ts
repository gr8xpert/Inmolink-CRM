import type { FeedListingInput } from '@inmolink/contracts';
import { MEDIA_PER_LISTING_MAX } from '@inmolink/contracts';
import type { FeedItemProblem, MapResult } from '../connectors';
import { htmlToPlainText } from '../html';
import { priceToCents } from '../values';

/**
 * Resales Online WebAPI V6 `SearchProperties` property to `FeedListing` (S6-06). Pure: no I/O. The field names are
 * the recorded shape of the V6 JSON response (fixtures in tests/fixtures/resales); `coverage.ts` lists every field
 * and where it goes. The ownership check is here too: a record that is not provably the connection's own never maps.
 */
export type ResalesRecord = Record<string, unknown>;

export interface ResalesSettings {
  /** The agency's own Resales Online agency id: records of any other agency are dropped. Falls back to the API identifier. */
  agencyId: string;
  defaultLocale: string;
}

export function resalesSettings(settings: Record<string, unknown>, identifier: string): ResalesSettings {
  const agency = typeof settings.agencyId === 'string' ? settings.agencyId.trim() : '';
  const locale = typeof settings.defaultLocale === 'string' ? settings.defaultLocale.trim() : '';
  return { agencyId: agency || identifier, defaultLocale: /^[a-z]{2}$/.test(locale) ? locale : 'en' };
}

const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
};
const obj = (v: unknown): ResalesRecord | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ResalesRecord) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function num(v: unknown): number | null {
  const s = str(v)?.replace(',', '.');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const positive = (v: unknown) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const count = (v: unknown) => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).trimEnd());

/** Whether the record belongs to the connection's own agency (an absent or different agency id: it does not). */
export function isOwnRecord(raw: ResalesRecord, settings: ResalesSettings): boolean {
  const owner = str(raw.AgencyId);
  return owner !== undefined && owner === settings.agencyId;
}

const problem = (code: string, field: string, message?: string): FeedItemProblem => ({
  code,
  field,
  ...(message ? { message } : {}),
});

export function mapResalesProperty(raw: ResalesRecord, settings: ResalesSettings): MapResult<FeedListingInput> {
  // Own listings only, twice over: the request asks for them (p_agency_filterid) and this drops the rest.
  // No ref and no message: nothing of another agency's record is stored or logged.
  if (!isOwnRecord(raw, settings)) return { ok: false, problems: [{ code: 'NOT_OWN_LISTING' }] };

  const ref = str(raw.Reference);
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'Reference', 'a property needs a Reference')] };
  const problems: FeedItemProblem[] = [];

  const status = str(obj(raw.Status)?.system)?.toLowerCase();
  // No ref on purpose: a property that turned Sold / Off Market counts as missing from the feed, so the loader withdraws it.
  if (status && status !== 'available')
    return { ok: false, problems: [problem('NOT_AVAILABLE', 'Status', 'only available properties are imported')] };
  const priceText = str(raw.Price);
  let priceCents: number | null = null;
  if (priceText !== undefined) {
    priceCents = priceToCents(priceText);
    if (priceCents === null) problems.push(problem('INVALID_PRICE', 'Price', 'a decimal number without separators'));
  }
  const priceOnRequest = priceCents === null || priceCents === 0;
  if (priceCents === 0) priceCents = null;

  const pt = obj(raw.PropertyType);
  const type = str(pt?.Type) ?? str(pt?.NameType);
  if (!type) problems.push(problem('MISSING_FIELD', 'PropertyType', 'the property type is required'));

  const lat = num(raw.Latitude);
  const lng = num(raw.Longitude);
  const coordinates =
    lat !== null && lng !== null && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng }
      : null;

  const city = str(raw.Location);
  const location: NonNullable<FeedListingInput['location']> = {
    country: str(raw.Country) ?? 'Spain',
    ...(str(raw.Province) ? { region: str(raw.Province) } : {}),
    ...(city ? { city } : {}),
    ...(str(raw.SubLocation) ? { area: str(raw.SubLocation) } : {}),
  };

  const features: string[] = [];
  const seen = new Set<string>();
  const addFeature = (t: string | undefined) => {
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      features.push(t);
    }
  };
  if (num(raw.Pool) === 1) addFeature('Pool');
  for (const cat of list(obj(raw.PropertyFeatures)?.Category))
    for (const v of list(obj(cat)?.Value)) addFeature(str(v));

  const description = htmlToPlainText(str(raw.Description) ?? '');
  const title = clip([type, city].filter(Boolean).join(', ') || ref, 200);

  const images: string[] = [];
  const addImage = (u: unknown) => {
    const url = str(u);
    if (url && /^https?:\/\/\S+$/i.test(url) && !images.includes(url) && images.length < MEDIA_PER_LISTING_MAX)
      images.push(url);
  };
  for (const pic of list(obj(raw.Pictures)?.Picture)) addImage(obj(pic)?.PictureURL);
  if (images.length === 0) addImage(raw.MainImage);

  if (problems.length > 0) return { ok: false, ref, problems };
  return {
    ok: true,
    ref,
    item: {
      ref,
      transactionType: 'SALE',
      pricePeriod: null,
      priceCents,
      priceOnRequest,
      currency: (str(raw.Currency) ?? 'EUR').toUpperCase(),
      builtM2: positive(raw.Built),
      plotM2: positive(raw.GardenPlot),
      bedrooms: count(raw.Bedrooms),
      bathrooms: count(raw.Bathrooms),
      energyRating: null,
      energyEmissionsRating: null,
      coordinates,
      locationPrecision: 'APPROX',
      propertyType: type as string,
      location,
      features,
      translations: [{ locale: settings.defaultLocale, title, description: description || null }],
      images,
    },
  };
}
