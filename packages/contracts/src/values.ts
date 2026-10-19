/**
 * Plain value lists of the contracts (S4-F2), without zod: client components import them from
 * `@inmolink/contracts/values`, so a page that only needs an option list or a column name does not bundle zod.
 * The zod schemas (`ListingStatus`, `ListingFilter`, …) are built from these lists; tests keep the two in step.
 * Never import zod here.
 */

/** A listing's lifecycle. */
export const LISTING_STATUSES = ['DRAFT', 'ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED', 'WITHDRAWN'] as const;
/** PLAN §3 #4: PRIVATE (owner) / SHARED (verified agents) / PUBLIC (marketplace, websites, portals). */
export const VISIBILITIES = ['PRIVATE', 'SHARED', 'PUBLIC'] as const;
/** PLAN §3 #57: a shared listing reaches every verified agency, or only the agencies the owner prefers. */
export const SHARE_SCOPES = ['ALL', 'PREFERRED'] as const;
export const TRANSACTION_TYPES = ['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM'] as const;

/** List orders: by creation (default newest first), last change, or price (listings without a price last). */
export const LISTING_SORTS = ['newest', 'oldest', 'updated', 'price_asc', 'price_desc'] as const;
export const LISTING_COLUMNS = [
  'ref',
  'type',
  'location',
  'price',
  'status',
  'visibility',
  'shareScope',
  'bedrooms',
  'bathrooms',
  'builtM2',
  'owner',
  'tags',
  'created',
  'updated',
] as const;
export const DEFAULT_LISTING_COLUMNS: readonly (typeof LISTING_COLUMNS)[number][] = [
  'ref',
  'type',
  'location',
  'price',
  'status',
  'visibility',
  'created',
];

/** The listing list's filter names (`ListingFilter`'s keys), in URL order. */
export const LISTING_FILTER_KEYS = [
  'status',
  'visibility',
  'transactionType',
  'propertyTypeId',
  'locationId',
  'ownerUserId',
  'mine',
  'priceMin',
  'priceMax',
  'bedroomsMin',
  'tag',
  'q',
] as const;

/** Longest listing tag (S3-07). */
export const LISTING_TAG_MAX = 40;
const TAG_CHARS = /^[^\p{C}]+$/u;

/** A listing tag as `ListingTag` stores it (trimmed, lower-case, 1–40 characters, no control characters), or null. */
export function normalizeListingTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase();
  return tag.length >= 1 && tag.length <= LISTING_TAG_MAX && TAG_CHARS.test(tag) ? tag : null;
}

/** Whether `value` is one of `list` (narrows it). */
export function isOneOf<const T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/** S4-F4: what a development document is (brochure, plans, price list, legal file …). */
export const DEVELOPMENT_DOCUMENT_KINDS = [
  'BROCHURE',
  'PRICE_LIST',
  'FLOOR_PLAN',
  'SPECIFICATIONS',
  'PAYMENT_PLAN',
  'LEGAL',
  'OTHER',
] as const;
/** A development document is a PDF of at most 20 MB (magic bytes checked, never the name or the header). */
export const DEVELOPMENT_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Units per development (S4-02): bounds every whole-development query (price list diffs, unit table). */
export const MAX_UNITS_PER_DEVELOPMENT = 2_000;
/** Units per bulk create or bulk edit. */
export const MAX_UNITS_PER_BULK = 500;

/** S6-04: connector key of the profile-driven generic XML connector. */
export const XML_MAPPED_CONNECTOR = 'xml-mapped';

/** S6-04: the scalar fields a generic XML mapping fills (`XmlMapping.fields`); `ref` and `propertyType` are required. */
export const XML_MAPPED_FIELDS = [
  'ref',
  'propertyType',
  'transactionType',
  'status',
  'price',
  'currency',
  'pricePeriod',
  'builtM2',
  'plotM2',
  'terraceM2',
  'bedrooms',
  'bathrooms',
  'yearBuilt',
  'energyRating',
  'energyEmissionsRating',
  'latitude',
  'longitude',
  'country',
  'region',
  'city',
  'area',
] as const;
export type XmlMappedField = (typeof XML_MAPPED_FIELDS)[number];
/** Fields whose values are a fixed set of words: the mapper offers a value translation for them. */
export const XML_MAPPED_ENUM_FIELDS = {
  transactionType: ['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM'],
  status: ['ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED'],
  pricePeriod: ['NIGHT', 'WEEK', 'MONTH'],
  energyRating: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING'],
  energyEmissionsRating: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING'],
} as const;

/** The sample the visual mapper reads: at most this many bytes (an upload over it is refused, a URL is cut off). */
export const MAPPER_SAMPLE = { maxBytes: 2 * 1024 * 1024, maxRecords: 25, maxPaths: 300, maxCandidates: 12 } as const;

/** S6-05: connector key of the CSV / Excel connector (a file the agency uploaded, mapped by a profile). */
export const SHEET_MAPPED_CONNECTOR = 'sheet-mapped';
/** Connectors whose connection needs a mapping profile (`XmlMapping`). */
export const MAPPING_CONNECTORS = [XML_MAPPED_CONNECTOR, SHEET_MAPPED_CONNECTOR] as const;
/** An uploaded CSV / XLSX file is refused over this size (the run reads it from storage, not the request). */
export const SHEET_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** The `upload://<file id>` address of a stored sheet: what a sheet connection keeps in `url`. */
export const SHEET_URL_PREFIX = 'upload://';
/** CSV / Excel limits (S6-05): rows with a value (header included) and columns; `platform/sheet` enforces them. */
export const SHEET_MAX_ROWS = 50_000;
export const SHEET_MAX_COLUMNS = 200;
