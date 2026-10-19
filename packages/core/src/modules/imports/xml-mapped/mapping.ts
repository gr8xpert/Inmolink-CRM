import {
  FEED_LISTING_STATUSES,
  type FeedListingInput,
  type MappedValue,
  MEDIA_PER_LISTING_MAX,
  type XmlMapping,
} from '@inmolink/contracts';
import { DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
import type { XmlElement } from '@inmolink/platform/xml';
import type { FeedItemProblem, MapResult } from '../connectors';
import { htmlToPlainText } from '../kyero/html';

/**
 * A record of any XML feed → the loader's `FeedListing`, driven by a mapping profile (S6-04). Pure: no I/O. Paths
 * are relative to the record element (`price`, `location/lat`, `images/image/@src`, `@id`); the profile says which
 * path feeds which field, and a value map translates the feed's words (`venta` → SALE). Anything a path cannot
 * give is a per-item problem with the field named, never a guess.
 */
export interface XmlMappedSettings {
  /** Locale of the generated title when the mapping has no translation (connection setting `defaultLocale`). */
  defaultLocale: string;
}

export function xmlMappedSettings(settings: Record<string, unknown>): XmlMappedSettings {
  const locale = typeof settings.defaultLocale === 'string' ? settings.defaultLocale.trim() : '';
  return { defaultLocale: /^[a-z]{2}$/.test(locale) ? locale : DEFAULT_CONTENT_LOCALE };
}

type Node = Pick<XmlElement, 'name' | 'attributes' | 'text' | 'children'>;

/** Every value at `path` below `record`, trimmed, empty ones dropped, in document order. */
export function valuesAt(record: Node, path: string): string[] {
  const segments = path.split('/');
  const last = segments.at(-1) as string;
  const attribute = last.startsWith('@') ? last.slice(1) : null;
  const elements = attribute === null ? segments : segments.slice(0, -1);
  let level: Node[] = [record];
  for (const name of elements) {
    level = level.flatMap((n) => n.children.filter((c) => c.name === name));
    if (level.length === 0) return [];
  }
  const out: string[] = [];
  for (const n of level) {
    const v = attribute === null ? n.text.trim() : (n.attributes[attribute] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

const problem = (code: string, field: string, message?: string): FeedItemProblem => ({
  code,
  field,
  ...(message ? { message } : {}),
});

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).trimEnd());

/** The value of a rule: constant or first path value, translated by the rule's map (case-insensitive). */
function read(record: Node, rule: MappedValue | undefined): string | undefined {
  if (!rule) return undefined;
  const raw = rule.constant ?? (rule.path ? valuesAt(record, rule.path)[0] : undefined);
  if (raw === undefined) return undefined;
  if (rule.map) {
    const wanted = raw.trim().toLowerCase();
    for (const [from, to] of Object.entries(rule.map)) {
      if (from.trim().toLowerCase() === wanted) return to.trim() === '' ? undefined : to.trim();
    }
  }
  return raw;
}

/** `1.250,50` (comma) or `1250.50` (point) → `1250.50`; null when it is not a plain number. */
function plainNumber(text: string, separator: 'point' | 'comma'): string | null {
  const t = text.trim().replace(/[\s ]/g, '');
  const normalised = separator === 'comma' ? t.replaceAll('.', '').replace(',', '.') : t;
  return /^-?\d+(\.\d+)?$/.test(normalised) ? normalised : null;
}

/** `1234.5` → 123450 cents; other shapes are refused (null), never guessed. */
function toCents(text: string, separator: 'point' | 'comma'): number | null {
  // 250.000 under a decimal point is almost certainly 250 000 written with a thousands point: refuse, never read as 250.00.
  if (separator === 'point' && /^\d{1,3}(\.\d{3})+$/.test(text.trim())) return null;
  const n = plainNumber(text, separator);
  const m = n ? /^(\d{1,12})(?:\.(\d{1,2})0*)?$/.exec(n) : null;
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : null;
}

const RATINGS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING']);
const TRANSACTIONS = new Set(['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM']);
const PERIODS = new Set(['NIGHT', 'WEEK', 'MONTH']);
const enumOf = (text: string) =>
  text
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

/** Language texts: the first one found per locale. */
function translationsOf(
  record: Node,
  mapping: XmlMapping,
  generatedTitle: string,
  settings: XmlMappedSettings,
): NonNullable<FeedListingInput['translations']> {
  const seen = new Set<string>();
  const out: NonNullable<FeedListingInput['translations']> = [];
  for (const t of mapping.translations) {
    if (seen.has(t.locale)) continue;
    const title = read(record, t.title);
    const description = read(record, t.description);
    if (title === undefined && description === undefined) continue;
    seen.add(t.locale);
    out.push({
      locale: t.locale,
      title: (title ? htmlToPlainText(title, 200) : '') || generatedTitle,
      description: description ? htmlToPlainText(description) || null : null,
    });
  }
  if (out.length === 0) out.push({ locale: settings.defaultLocale, title: generatedTitle, description: null });
  return out;
}

function listOf(record: Node, sources: XmlMapping['features'], max: number, maxLength: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const value of valuesAt(record, source.path)) {
      const parts = source.separator ? value.split(source.separator) : [value];
      for (const part of parts) {
        const text = part.trim();
        if (text && text.length <= maxLength && !seen.has(text.toLowerCase()) && out.length < max) {
          seen.add(text.toLowerCase());
          out.push(text);
        }
      }
    }
  }
  return out;
}

export function mapXmlRecord(raw: Node, mapping: XmlMapping, settings: XmlMappedSettings): MapResult<FeedListingInput> {
  const f = mapping.fields;
  const sep = mapping.decimalSeparator;
  const ref = read(raw, f.ref);
  if (!ref) return { ok: false, problems: [problem('MISSING_FIELD', 'ref', 'the record has no reference')] };
  const problems: FeedItemProblem[] = [];

  // transaction and price
  let transactionType: FeedListingInput['transactionType'] = 'SALE';
  const transactionText = read(raw, f.transactionType);
  if (transactionText !== undefined) {
    const t = enumOf(transactionText);
    if (TRANSACTIONS.has(t)) transactionType = t as FeedListingInput['transactionType'];
    else
      problems.push(
        problem('INVALID_FIELD', 'transactionType', 'map this value to SALE, RENT_LONG_TERM or RENT_SHORT_TERM'),
      );
  }
  let pricePeriod: FeedListingInput['pricePeriod'] = null;
  if (transactionType !== 'SALE') {
    pricePeriod = transactionType === 'RENT_LONG_TERM' ? 'MONTH' : 'WEEK';
    const periodText = read(raw, f.pricePeriod);
    if (periodText !== undefined) {
      const p = enumOf(periodText);
      if (PERIODS.has(p)) pricePeriod = p as FeedListingInput['pricePeriod'];
      else problems.push(problem('INVALID_FIELD', 'pricePeriod', 'map this value to NIGHT, WEEK or MONTH'));
    }
  }
  let priceCents: number | null = null;
  const priceText = read(raw, f.price);
  if (priceText !== undefined) {
    priceCents = toCents(priceText, sep);
    if (priceCents === null) problems.push(problem('INVALID_PRICE', 'price', 'a plain decimal number'));
  }
  const priceOnRequest = priceCents === null || priceCents === 0;
  if (priceCents === 0) priceCents = null;

  let status: (typeof FEED_LISTING_STATUSES)[number] = 'ACTIVE';
  const statusText = read(raw, f.status);
  if (statusText !== undefined) {
    const s = enumOf(statusText);
    if ((FEED_LISTING_STATUSES as readonly string[]).includes(s)) status = s as typeof status;
    else problems.push(problem('INVALID_FIELD', 'status', 'map this value to ACTIVE, UNDER_OFFER, SOLD or RENTED'));
  }

  const number = (field: 'builtM2' | 'plotM2' | 'terraceM2' | 'latitude' | 'longitude'): number | null => {
    const text = read(raw, f[field]);
    if (text === undefined) return null;
    // Coordinates never carry thousands separators: either decimal mark is read as the mark, whatever the feed's price format.
    const n = plainNumber(
      field === 'latitude' || field === 'longitude' ? text.replace(',', '.') : text,
      field === 'latitude' || field === 'longitude' ? 'point' : sep,
    );
    if (n === null) {
      problems.push(problem('INVALID_FIELD', field, 'a plain number'));
      return null;
    }
    return Number(n);
  };
  const area = (field: 'builtM2' | 'plotM2' | 'terraceM2') => {
    const n = number(field);
    return n !== null && n > 0 ? n : null;
  };
  const count = (field: 'bedrooms' | 'bathrooms' | 'yearBuilt'): number | null => {
    const text = read(raw, f[field]);
    if (text === undefined) return null;
    const n = plainNumber(text, sep);
    if (n === null || !Number.isInteger(Number(n)) || Number(n) < 0) {
      problems.push(problem('INVALID_FIELD', field, 'a whole number'));
      return null;
    }
    return Number(n);
  };
  const rating = (field: 'energyRating' | 'energyEmissionsRating'): FeedListingInput['energyRating'] => {
    const text = read(raw, f[field]);
    if (text === undefined) return null;
    const r = enumOf(text);
    if (RATINGS.has(r)) return r as 'A';
    problems.push(problem('INVALID_FIELD', field, 'map this value to A to G, EXEMPT or PENDING'));
    return null;
  };

  const lat = number('latitude');
  const lng = number('longitude');
  const coordinates =
    lat !== null && lng !== null && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng }
      : null;

  const propertyType = read(raw, f.propertyType);
  if (!propertyType) problems.push(problem('MISSING_FIELD', 'propertyType', 'the property type is required'));
  const location: NonNullable<FeedListingInput['location']> = {};
  for (const level of ['country', 'region', 'city', 'area'] as const) {
    const v = read(raw, f[level]);
    if (v) location[level] = clip(v, 200);
  }
  if (!Object.values(location).some(Boolean)) {
    problems.push(problem('MISSING_FIELD', 'location', 'at least one of country, region, city or area is required'));
  }

  const generatedTitle = clip([propertyType, location.city ?? location.area].filter(Boolean).join(', ') || ref, 200);
  const images = listOf(raw, mapping.images, MEDIA_PER_LISTING_MAX, 2_048).filter((u) => /^https?:\/\/\S+$/i.test(u));
  const currencyText = read(raw, f.currency);
  const values = {
    builtM2: area('builtM2'),
    plotM2: area('plotM2'),
    terraceM2: area('terraceM2'),
    bedrooms: count('bedrooms'),
    bathrooms: count('bathrooms'),
    yearBuilt: count('yearBuilt'),
    energyRating: rating('energyRating'),
    energyEmissionsRating: rating('energyEmissionsRating'),
  };

  if (problems.length > 0) return { ok: false, ref: clip(ref, 200), problems };
  return {
    ok: true,
    ref,
    item: {
      ref,
      transactionType,
      status,
      pricePeriod,
      priceCents,
      priceOnRequest,
      ...(currencyText ? { currency: currencyText.toUpperCase() } : {}),
      ...values,
      coordinates,
      locationPrecision: 'APPROX',
      propertyType: clip(propertyType as string, 200),
      location,
      features: listOf(raw, mapping.features, 200, 200),
      translations: translationsOf(raw, mapping, generatedTitle, settings),
      images,
    },
  };
}
