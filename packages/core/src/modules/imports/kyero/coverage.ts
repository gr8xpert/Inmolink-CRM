import type { XmlElement } from '@inmolink/platform/xml';

/**
 * The Kyero v3 field map (S6-03): every element of the format (and the attribute it carries) with the
 * `FeedListing` field it feeds, or the reason it is ignored. The mapper (`mapping.ts`) is the implementation; this
 * table is the report ("100% field mapping coverage") and a test walks every element of the fixture feeds against
 * it, so a new element in a feed either gets a row here or fails the test. Paths are relative to the record
 * (`<property>`); `*` stands for a language code (`desc/en`, `desc/es`, ...). The header record `<kyero>` is
 * listed with its own name.
 */
export interface KyeroFieldRule {
  path: string;
  /** The `FeedListing` field(s) it feeds; null when ignored. */
  maps: string | null;
  /** Why an ignored element is ignored, or how a mapped one is read. */
  note: string;
}

export const KYERO_V3_FIELDS: readonly KyeroFieldRule[] = [
  {
    path: 'kyero/feed_version',
    maps: null,
    note: 'Feed header outside the records; version 3 is what this connector reads.',
  },
  {
    path: 'id',
    maps: 'ref',
    note: 'The listing key of the feed (the re-import key). Falls back to `ref` when absent.',
  },
  {
    path: 'ref',
    maps: 'ref',
    note: 'Used as the key when `id` is missing; otherwise the agent reference is not stored.',
  },
  {
    path: 'date',
    maps: null,
    note: 'Feed-side change time; unchanged content is detected by the import hash instead.',
  },
  {
    path: 'price',
    maps: 'priceCents, priceOnRequest',
    note: 'Decimal in the currency; missing or 0 means price on request.',
  },
  { path: 'currency', maps: 'currency', note: 'ISO 4217 code; EUR when absent.' },
  {
    path: 'price_freq',
    maps: 'transactionType, pricePeriod',
    note: 'sale: SALE; month: RENT_LONG_TERM per MONTH; week: RENT_SHORT_TERM per WEEK.',
  },
  { path: 'part_ownership', maps: null, note: 'Ownership structure is not modelled on listings.' },
  { path: 'leasehold', maps: null, note: 'Tenure is not modelled on listings.' },
  { path: 'new_build', maps: null, note: 'Condition is not modelled on listings.' },
  {
    path: 'type',
    maps: 'propertyType',
    note: 'Free text, resolved by the taxonomy resolver (unmatched: DRAFT hold and staff queue).',
  },
  { path: 'town', maps: 'location.city', note: 'Resolved under the province.' },
  { path: 'province', maps: 'location.region', note: 'Resolved under the country.' },
  {
    path: 'country',
    maps: 'location.country',
    note: 'Not part of v3 but sent by some CRMs; else the connection setting `defaultCountry` (Spain).',
  },
  { path: 'location', maps: 'coordinates', note: 'Container of latitude and longitude; 0,0 is treated as missing.' },
  { path: 'location/latitude', maps: 'coordinates.lat', note: 'Decimal degrees.' },
  {
    path: 'location/longitude',
    maps: 'coordinates.lng',
    note: 'Decimal degrees. Precision stays APPROX (agents move pins).',
  },
  { path: 'location_detail', maps: 'location.area', note: 'Neighbourhood or urbanisation; resolved under the town.' },
  { path: 'beds', maps: 'bedrooms', note: 'Integer.' },
  { path: 'baths', maps: 'bathrooms', note: 'Integer.' },
  { path: 'pool', maps: 'features', note: '1 adds the feature "Pool" (resolved like any feature).' },
  { path: 'surface_area', maps: 'builtM2, plotM2', note: 'Container.' },
  { path: 'surface_area/built', maps: 'builtM2', note: 'Square metres.' },
  { path: 'surface_area/plot', maps: 'plotM2', note: 'Square metres.' },
  { path: 'energy_rating', maps: 'energyRating, energyEmissionsRating', note: 'Container.' },
  {
    path: 'energy_rating/consumption',
    maps: 'energyRating',
    note: 'A-G, exempt or in_progress; anything else is dropped.',
  },
  {
    path: 'energy_rating/emissions',
    maps: 'energyEmissionsRating',
    note: 'A-G, exempt or in_progress; anything else is dropped.',
  },
  { path: 'url', maps: null, note: 'Container of the source agency page per language.' },
  {
    path: 'url/*',
    maps: null,
    note: 'The source agency page: Inmolink builds its own pages and does not link to the feed owner.',
  },
  { path: 'desc', maps: 'translations', note: 'Container of one description per language.' },
  {
    path: 'desc/*',
    maps: 'translations[].description',
    note: 'HTML reduced to plain text; the locale is the element name.',
  },
  { path: 'title', maps: 'translations', note: 'Not part of v3 but sent by some CRMs: container per language.' },
  {
    path: 'title/*',
    maps: 'translations[].title',
    note: 'Used when present; otherwise "<type>, <town>" from the data.',
  },
  { path: 'features', maps: 'features', note: 'Container.' },
  { path: 'features/feature', maps: 'features', note: 'One feature per element, resolved by the taxonomy resolver.' },
  { path: 'images', maps: 'images', note: 'Container.' },
  { path: 'images/image', maps: 'images', note: 'Feed order is kept.' },
  { path: 'images/image@id', maps: null, note: 'Feed-side image number; the order comes from the document.' },
  {
    path: 'images/image/url',
    maps: 'images[]',
    note: 'http(s) only; fetched later by the media worker through safeFetch.',
  },
];

const BY_PATH = new Map(KYERO_V3_FIELDS.map((r) => [r.path, r]));
/** The mapper keeps two-letter language elements only (`desc/en`); other names are not mapped. */
const LANGUAGE = /^[A-Za-z]{2}$/;

/** Rule of one element path as found in a feed (`desc/de` resolves to the `desc/*` rule). */
export function ruleFor(path: string): KyeroFieldRule | undefined {
  const exact = BY_PATH.get(path);
  if (exact) return exact;
  const slash = path.lastIndexOf('/');
  if (slash > 0 && LANGUAGE.test(path.slice(slash + 1))) return BY_PATH.get(`${path.slice(0, slash)}/*`);
  return undefined;
}

/** Paths (elements and `@attributes`) below a record, relative to it, without duplicates. */
export function elementPaths(record: XmlElement): string[] {
  const out = new Set<string>();
  const walk = (el: XmlElement, path: string) => {
    if (path) {
      out.add(path);
      for (const attr of Object.keys(el.attributes)) out.add(`${path}@${attr}`);
    }
    for (const child of el.children) walk(child, path ? `${path}/${child.name}` : child.name);
  };
  walk(record, '');
  return [...out];
}

/** Paths of a `<property>` record the field map does not account for (a new element in the format). */
export function unaccountedPaths(record: XmlElement): string[] {
  return elementPaths(record).filter((p) => !ruleFor(p));
}

/** The coverage report as Markdown (every v3 element, where it maps or why it is ignored). */
export function renderCoverageReport(): string {
  const rows = KYERO_V3_FIELDS.map((r) => `| \`${r.path}\` | ${r.maps ? `\`${r.maps}\`` : 'ignored'} | ${r.note} |`);
  return ['| Kyero v3 element | Maps to | Note |', '| --- | --- | --- |', ...rows].join('\n');
}
