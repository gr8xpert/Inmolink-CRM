import type { FeedListingInput } from '@inmolink/contracts';
import { MEDIA_PER_LISTING_MAX } from '@inmolink/contracts';
import { CONTENT_LOCALES, isContentLocale } from '@inmolink/i18n';
import { formatDefaults } from '../config';
import type { FeedItemProblem, MapResult } from '../connectors';
import { htmlToPlainText } from '../html';
import { clip, priceToCents, rating, truthy, year } from '../values';

/**
 * Resales Online WebAPI V6 to `FeedListing` (S6-06, reworked in S6-F4 against the SPW project's adapter, which runs in
 * production). Pure: no I/O. The connector merges a `SearchProperties` record with its `PropertyDetails` record and
 * adds the per-language descriptions; this maps the result. `coverage.ts` lists every field and where it goes.
 */
export type ResalesRecord = Record<string, unknown>;

/**
 * One record as the connector hands it to `map` (own records only; shared ones are dropped and counted by the
 * connector). `unchanged`: its list fields hash as last stored, so it is reported as seen only; `failure`: its details
 * or a language could not be read, so it fails with its reference (kept as stored, never withdrawn).
 */
export interface ResalesItem {
  own: boolean;
  ref?: string;
  unchanged?: boolean;
  failure?: 'DETAILS_UNAVAILABLE' | 'TRANSLATIONS_UNAVAILABLE';
  /** The hash to store once the listing is stored. */
  sourceHash?: string;
  /** `QueryInfo.SearchType` of the page ("Sale", "Short Term Rental", …), when the API sent one. */
  searchType?: string | null;
  property?: ResalesRecord;
  /** The `PropertyDetails` record, or null when that call failed (the list record is mapped alone). */
  detail?: ResalesRecord | null;
  /** Descriptions from the per-language `SearchProperties` calls, by content locale (never the base locale). */
  descriptions?: Record<string, string>;
}

/**
 * The Filter Alias of the agency's Resales portal (`p_agency_filterid`): 1 Sale, 2 Short Term Rent, 3 Long Term Rent,
 * 4 Featured. Not the numeric Filter Id (that answers "FilterAgencyId not valid"). One connection per alias.
 */
export const RESALES_FILTER_ALIASES = ['1', '2', '3', '4'] as const;
export type ResalesFilterAlias = (typeof RESALES_FILTER_ALIASES)[number];

/**
 * `P_Lang` takes Resales' numbers; letter codes are silently ignored and give English (probed live by SPW,
 * 2026-10-14). English is what a request without `P_Lang` returns.
 */
export const RESALES_LANGUAGE_CODES: Readonly<Record<string, number>> = {
  es: 2,
  de: 3,
  fr: 4,
  nl: 5,
  da: 6,
  ru: 7,
  sv: 8,
  pl: 9,
  no: 10,
  tr: 11,
  fi: 13,
  hu: 14,
  vi: 15,
};

export interface ResalesSettings {
  filterAlias: ResalesFilterAlias;
  /** Locales fetched with one extra `SearchProperties` call per page each (codes of `RESALES_LANGUAGE_CODES`). */
  languages: string[];
  /** The language of the request without `P_Lang` (English) and of the generated title. */
  defaultLocale: string;
  /** Currency of a price without `Currency`. */
  defaultCurrency: string;
  /** Country of a record without `Country`. */
  defaultCountry: string;
}

/** The connection's filter alias is not one of 1–4: the run fails before anything is sent. */
export class ResalesSettingsError extends Error {
  override readonly name = 'ResalesSettingsError';
  constructor() {
    super('the Resales Online filter alias must be 1, 2, 3 or 4');
  }
}

/**
 * The connection's settings over Resales Online's defaults (`FORMAT_DEFAULTS`, S7-F2). `filterAlias` (default `1`,
 * Sale); `languages` a comma list (default: the platform's content locales Resales has, except the base one; an empty
 * string fetches the base language only).
 */
export function resalesSettings(settings: Record<string, unknown>): ResalesSettings {
  const d = formatDefaults('resales-online', settings);
  const rawAlias = settings.filterAlias ?? '1';
  const alias = String(typeof rawAlias === 'number' || typeof rawAlias === 'string' ? rawAlias : '').trim();
  if (!(RESALES_FILTER_ALIASES as readonly string[]).includes(alias)) throw new ResalesSettingsError();
  const wanted =
    typeof settings.languages === 'string'
      ? settings.languages.split(',').map((l) => l.trim().toLowerCase())
      : [...CONTENT_LOCALES];
  const languages = [...new Set(wanted)].filter(
    (l) => l !== d.locale && RESALES_LANGUAGE_CODES[l] !== undefined && isContentLocale(l),
  );
  return {
    filterAlias: alias as ResalesFilterAlias,
    languages,
    defaultLocale: d.locale,
    defaultCurrency: d.currency,
    defaultCountry: d.country,
  };
}

const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
};
const obj = (v: unknown): ResalesRecord | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ResalesRecord) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** The own-property field as SPW reads it (`OwnProperty`; also `Own`, `IsOwnProperty`). Confirm at H13. */
export const OWN_PROPERTY_KEYS = ['OwnProperty', 'Own', 'IsOwnProperty'] as const;

/** Whether a `SearchProperties` record is the agency's own (`OwnProperty` "1"). */
export function isOwnProperty(raw: ResalesRecord): boolean {
  return truthy(str(raw.OwnProperty ?? raw.Own ?? raw.IsOwnProperty));
}

/** A number as Resales writes it: `"2"`, `2`, `"2.5"`, `"1,200"` (thousands). Anything else: null. */
export function resalesNumber(v: unknown): number | null {
  const s = str(v)?.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** `"1 - 3"` → its low end; `"2.5"` → 2.5. */
export function rangeLow(v: unknown): number | null {
  const s = str(v);
  if (s === undefined) return null;
  const [low] = s.split(/\s+-\s+|\s*-\s*(?=\d)/);
  return resalesNumber(low);
}

const area = (v: unknown) => {
  const n = rangeLow(v);
  return n !== null && n > 0 && n < 100_000_000 ? n : null;
};
/** Bedrooms and bathrooms: the low end, whole (a half bath "2.5" counts as 2; the contract holds whole numbers). */
const roomCount = (v: unknown) => {
  const n = rangeLow(v);
  return n !== null && n >= 0 && n <= 1000 ? Math.floor(n) : null;
};

/** A price: `"550,000"`, `"1250000"`, `1250000.5`; a range `"96091 - 234530"` gives its low end; `"POA"` none. */
export function resalesPriceCents(v: unknown): { cents: number | null; onRequest: boolean; invalid: boolean } {
  const s = str(v);
  if (s === undefined) return { cents: null, onRequest: true, invalid: false };
  if (/^poa$/i.test(s)) return { cents: null, onRequest: true, invalid: false };
  const [low] = s.split(/\s+-\s+|\s*-\s*(?=\d)/);
  const text = (low ?? '')
    .replace(/(?:€|eur)$/i, '')
    .trim()
    .replace(/,(?=\d{3}(\D|$))/g, '');
  const cents = priceToCents(text);
  if (cents === null) return { cents: null, onRequest: true, invalid: true };
  return cents === 0 ? { cents: null, onRequest: true, invalid: false } : { cents, onRequest: false, invalid: false };
}

type Transaction = FeedListingInput['transactionType'];
const ALIAS_TRANSACTION: Record<ResalesFilterAlias, Transaction> = {
  '1': 'SALE',
  '2': 'RENT_SHORT_TERM',
  '3': 'RENT_LONG_TERM',
  '4': 'SALE',
};

/** The page's `SearchType` when it names one, else the filter alias's. */
export function resalesTransaction(searchType: string | null | undefined, alias: ResalesFilterAlias): Transaction {
  const t = (searchType ?? '').toLowerCase();
  if (/short\s*term|holiday/.test(t)) return 'RENT_SHORT_TERM';
  if (/long\s*term|rent/.test(t)) return 'RENT_LONG_TERM';
  if (/sale|resale|development/.test(t)) return 'SALE';
  return ALIAS_TRANSACTION[alias];
}

function rentalPeriod(v: unknown): FeedListingInput['pricePeriod'] {
  const t = (str(v) ?? '').toLowerCase();
  if (/night|day|noche|d[ií]a/.test(t)) return 'NIGHT';
  if (/week|semana/.test(t)) return 'WEEK';
  if (/month|mes/.test(t)) return 'MONTH';
  return null;
}

/** A new development, however the feed marks it (SPW: all three agree on a live feed; any one is enough). */
export function isNewDevelopment(p: ResalesRecord): boolean {
  if (/development/i.test(str(obj(p.PropertyType)?.NameType) ?? '')) return true;
  if (str(p.KeyReady) !== undefined) return true;
  return list(obj(p.PropertyFeatures)?.Category).some((c) => {
    const cat = obj(c);
    const heading = (str(cat?.Type) ?? str(cat?.['@_Type']) ?? '').toLowerCase();
    return heading === 'category' && list(cat?.Value).some((v) => /new development/i.test(str(v) ?? ''));
  });
}

/** Coordinates: `Latitude`/`Longitude`, `GPS_Latitude`/`GPS_Longitude`, or `GpsX`/`GpsY` in either order (Spain: lat 27–44). */
export function resalesCoordinates(p: ResalesRecord): { lat: number; lng: number } | null {
  let lat = resalesNumber(p.Latitude ?? p.GPS_Latitude);
  let lng = resalesNumber(p.Longitude ?? p.GPS_Longitude);
  if (lat === null || lng === null) {
    const x = resalesNumber(p.GpsX);
    const y = resalesNumber(p.GpsY);
    const isLat = (v: number) => v >= 27 && v <= 44;
    if (x !== null && y !== null) {
      if (isLat(y) && !isLat(x)) [lat, lng] = [y, x];
      else if (isLat(x) && !isLat(y)) [lat, lng] = [x, y];
    }
  }
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** The listing status: sold / off market / rented are not imported (withdrawn as missing); under offer kept as such. */
function statusOf(p: ResalesRecord): 'ACTIVE' | 'UNDER_OFFER' | 'GONE' {
  const s = obj(p.Status);
  const text = (str(p.Status) ?? str(s?.en) ?? str(s?.system) ?? '').toLowerCase();
  if (/sold|off\s*market|withdrawn|rented|\blet\b/.test(text)) return 'GONE';
  if (/under\s*offer|reserved/.test(text)) return 'UNDER_OFFER';
  return 'ACTIVE';
}

/** The base-language description: a plain string, or the English entry of a `{ EN, ES, … }` object. */
function descriptionsOf(v: unknown, base: string): Record<string, string> {
  const s = str(v);
  if (s !== undefined) return { [base]: s };
  const out: Record<string, string> = {};
  for (const [k, text] of Object.entries(obj(v) ?? {})) {
    const t = str(text);
    if (t !== undefined) out[k.toLowerCase()] = t;
  }
  return out;
}

const problem = (code: string, field: string, message?: string): FeedItemProblem => ({
  code,
  field,
  ...(message ? { message } : {}),
});

export function mapResalesProperty(item: ResalesItem, settings: ResalesSettings): MapResult<FeedListingInput> {
  // Own listings only (PLAN §3 #17). No ref and no message: nothing of another agency's record is stored or logged.
  if (!item.own) return { ok: false, problems: [{ code: 'NOT_OWN_LISTING' }] };
  const knownRef = item.ref?.trim();
  if (knownRef && item.unchanged) return { ok: false, ref: knownRef, problems: [], seen: true };
  if (knownRef && item.failure) {
    const field = item.failure === 'DETAILS_UNAVAILABLE' ? 'PropertyDetails' : 'Description';
    const message =
      item.failure === 'DETAILS_UNAVAILABLE'
        ? 'the details could not be read; the listing is kept as it is'
        : 'a language could not be read; the listing is kept as it is';
    return { ok: false, ref: knownRef, problems: [problem(item.failure, field, message)] };
  }
  if (!item.property) return { ok: false, problems: [{ code: 'NOT_OWN_LISTING' }] };
  // PropertyDetails over the list record, as SPW merges them; the list's flat location stays readable below.
  const listRecord = item.property;
  const p: ResalesRecord = { ...listRecord, ...(item.detail ?? {}) };

  const ref = str(p.Reference);
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'Reference', 'a property needs a Reference')] };
  const problems: FeedItemProblem[] = [];

  const status = statusOf(p);
  // No ref on purpose: a property that turned Sold / Off Market counts as missing from the feed, so the loader withdraws it.
  if (status === 'GONE')
    return { ok: false, problems: [problem('NOT_AVAILABLE', 'Status', 'only available properties are imported')] };

  const transactionType = resalesTransaction(item.searchType, settings.filterAlias);
  // Rentals send RentalPrice1 (from), RentalPrice2 (to) and RentalPeriod instead of Price.
  const rental = transactionType !== 'SALE' && (p.RentalPrice1 !== undefined || p.RentalPrice2 !== undefined);
  let price = resalesPriceCents(rental ? (str(p.RentalPrice1) ?? p.RentalPrice2) : p.Price);
  if (rental && price.cents === null && str(p.RentalPrice2) !== undefined) price = resalesPriceCents(p.RentalPrice2);
  if (price.invalid) problems.push(problem('INVALID_PRICE', rental ? 'RentalPrice1' : 'Price', 'not a price'));
  const onRequest = price.onRequest || /^yes$/i.test(str(p.PriceOnApplication) ?? '');
  const pricePeriod = transactionType === 'SALE' ? null : rentalPeriod(p.RentalPeriod);

  const pt = obj(p.PropertyType);
  const development = isNewDevelopment(p);
  const type = development
    ? (str(pt?.Subtype1) ?? str(pt?.Type))
    : (str(pt?.NameType) ?? str(pt?.Subtype1) ?? str(pt?.Type));
  if (!type) problems.push(problem('MISSING_FIELD', 'PropertyType', 'the property type is required'));

  // SearchProperties: flat Province / Area / Location / SubLocation; PropertyDetails nests them under Location.
  const loc = obj(p.Location);
  const city = str(loc?.LocationName) ?? str(p.Location) ?? str(listRecord.Location);
  const province = str(loc?.Province) ?? str(p.Province);
  const sub = str(loc?.SubLocation) ?? str(p.SubLocation);
  const location: NonNullable<FeedListingInput['location']> = {
    country: str(loc?.Country) ?? str(p.Country) ?? settings.defaultCountry,
    ...(province ? { region: province } : {}),
    ...(city ? { city } : {}),
    ...(sub && sub.toLowerCase() !== city?.toLowerCase() ? { area: sub } : {}),
  };

  const features: string[] = [];
  const seen = new Set<string>();
  const addFeature = (t: string | undefined) => {
    if (t && t.length <= 200 && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      features.push(t);
    }
  };
  if (resalesNumber(p.Pool) === 1) addFeature('Pool');
  for (const cat of list(obj(p.PropertyFeatures)?.Category)) for (const v of list(obj(cat)?.Value)) addFeature(str(v));

  const title = clip([type, city].filter(Boolean).join(', ') || ref, 200);
  const base = settings.defaultLocale;
  const texts: Record<string, string> = { ...descriptionsOf(p.Description, base), ...(item.descriptions ?? {}) };
  const baseText = htmlToPlainText(texts[base] ?? '');
  const translations: NonNullable<FeedListingInput['translations']> = [
    { locale: base, title, description: baseText || null },
  ];
  for (const [locale, raw] of Object.entries(texts)) {
    if (locale === base || !isContentLocale(locale)) continue;
    const text = htmlToPlainText(raw);
    // Text identical to the base language is Resales' fallback, not a translation: left out.
    if (text && text !== baseText) translations.push({ locale, title, description: text });
  }

  const images: string[] = [];
  const addImage = (u: unknown) => {
    const url = str(u);
    if (url && /^https?:\/\/\S+$/i.test(url) && !images.includes(url) && images.length < MEDIA_PER_LISTING_MAX)
      images.push(url);
  };
  for (const pic of list(obj(p.Pictures)?.Picture)) addImage(obj(pic)?.PictureURL);
  if (images.length === 0) addImage(p.MainImage);

  if (problems.length > 0) return { ok: false, ref, problems };
  return {
    ok: true,
    ref,
    ...(item.sourceHash ? { sourceHash: item.sourceHash } : {}),
    item: {
      ref,
      transactionType,
      status,
      pricePeriod,
      priceCents: price.cents,
      priceOnRequest: onRequest,
      currency: (str(p.Currency) ?? settings.defaultCurrency).toUpperCase(),
      builtM2: area(p.Built ?? p.BuiltArea),
      plotM2: area(p.GardenPlot ?? p.Plot),
      terraceM2: area(p.Terrace),
      bedrooms: roomCount(p.Bedrooms),
      bathrooms: roomCount(p.Bathrooms),
      yearBuilt: year(str(p.BuiltYear)),
      energyRating: rating(str(p.EnergyRating ?? p.EnergyRatingConsumption)),
      energyEmissionsRating: null,
      coordinates: resalesCoordinates(p),
      locationPrecision: 'APPROX',
      propertyType: type as string,
      location,
      features,
      translations,
      images,
    },
  };
}
