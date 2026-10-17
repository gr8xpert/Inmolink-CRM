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
