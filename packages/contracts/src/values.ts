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
/** A development's brand name, at most (dashboard and feeds alike, S8-F3). */
export const MAX_DEVELOPMENT_NAME = 160;
/**
 * The fields a feed sets on a development it created that the owner may lock (S8-F5, like a listing's field locks):
 * a feed run leaves a locked field as the owner set it. Editing one by hand locks it.
 */
export const LOCKABLE_DEVELOPMENT_FIELDS = ['name', 'location'] as const;
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

/** Longest e-mail address (RFC 5321 path limit): the `Email` schema and the widget's lead form (S8-F8). */
export const EMAIL_MAX_LENGTH = 254;
/** Website lead form caps (S7-05; zod-free since S8-F8, so the JS widget sets the same `maxlength` without zod). */
export const LEAD_LIMITS = {
  name: 120,
  email: EMAIL_MAX_LENGTH,
  phone: 25,
  message: 4_000,
  pageUrl: 2_048,
  turnstileToken: 2_048,
  viewingSlots: 3,
} as const;
/**
 * The Turnstile widget action website lead forms render with (`data-action`, S7-05): the website API refuses a token
 * solved for another action. The JS widget (S8-F8) and core `website-api` both read it here.
 */
export const WEBSITE_LEAD_TURNSTILE_ACTION = 'website-lead';
/** A viewing request slot's part of the day (S7-05). */
export const VIEWING_TIMES_OF_DAY = ['MORNING', 'AFTERNOON', 'EVENING', 'ANY'] as const;

// ---- Media (moved from media.ts so client components avoid zod) ----
/** Largest original accepted (a 48 MP PNG fits; a 12 MP JPEG is ~5 MB). */
export const MEDIA_MAX_BYTES = 40 * 1024 * 1024;
/** Files per check or register call. */
export const MEDIA_BATCH_MAX = 100;
/** Media rows one listing may have. */
export const MEDIA_PER_LISTING_MAX = 100;
/** Image types accepted as originals, detected by magic bytes (HEIC is converted by the media worker, S3-04). */
export const MEDIA_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** Rooms an image can show (S3-06): set by the agent; AI tagging fills the same field later. */
export const LISTING_ROOM_TYPES = [
  'EXTERIOR',
  'FACADE',
  'LIVING_ROOM',
  'DINING_ROOM',
  'KITCHEN',
  'BEDROOM',
  'BATHROOM',
  'OFFICE',
  'HALL',
  'TERRACE',
  'BALCONY',
  'GARDEN',
  'POOL',
  'GARAGE',
  'STORAGE',
  'VIEW',
  'COMMUNITY',
  'OTHER',
] as const;

/** A listing document is a PDF of at most 20 MB (magic bytes checked, never the name or the header). */
export const LISTING_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Listings per Listing Studio bulk request (one batch job; its payload stays under the 10 KB job cap). S13-F14. */
export const LISTING_STUDIO_BULK_MAX = 100;

/** Listings per selection (S12-04). The listings bulk bar hands its picks over in the URL, so it caps at this too. */
export const SELECTION_ITEMS_MAX = 50;

/** PLAN §3 #2: the staff roles (`staff_users.role`). `StaffRole` (zod) is built from this list. */
export const STAFF_ROLES = ['SUPER_ADMIN', 'STAFF_SUPPORT', 'STAFF_DATA_OPS'] as const;
type StaffRoleName = (typeof STAFF_ROLES)[number];

/**
 * S14-F2: the staff role sets — the single source for both sides of each staff rule: the tenant registry builds its
 * RLS predicates from them (`staffRoleSql`) and the staff policies check them, so RLS and policy cannot drift.
 */
/** Plan grants, price locks, the plan catalog, feature flags, ending anyone's impersonation: super admins only. */
export const SUPER_ADMIN_ROLES = ['SUPER_ADMIN'] as const satisfies readonly StaffRoleName[];
/** Who may start and cancel bulk operations (S13-03); every staff role sees them. */
export const STAFF_OPERATION_ROLES = ['SUPER_ADMIN', 'STAFF_DATA_OPS'] as const satisfies readonly StaffRoleName[];
/** Who replies to, triages and keeps internal notes on support tickets (S13-05); every staff role reads them. */
export const SUPPORT_AGENT_ROLES = ['SUPER_ADMIN', 'STAFF_SUPPORT'] as const satisfies readonly StaffRoleName[];
