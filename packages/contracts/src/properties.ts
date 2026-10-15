/** properties DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { Commission, MAX_SPLIT_BP } from './agency-profile';
import { CurrencyCode, Money, pageOf } from './common';

export const ListingStatus = z.enum(['DRAFT', 'ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED', 'WITHDRAWN']);
export type ListingStatus = z.infer<typeof ListingStatus>;
/** PLAN §3 #4: PRIVATE (owner) / SHARED (verified agents) / PUBLIC (marketplace, websites, portals). */
export const Visibility = z.enum(['PRIVATE', 'SHARED', 'PUBLIC']);
export type Visibility = z.infer<typeof Visibility>;
/** PLAN §3 #57: a shared listing reaches every verified agency, or only the agencies the owner prefers. */
export const ShareScope = z.enum(['ALL', 'PREFERRED']);
export type ShareScope = z.infer<typeof ShareScope>;
export const TransactionType = z.enum(['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM']);
export type TransactionType = z.infer<typeof TransactionType>;
export const PricePeriod = z.enum(['NIGHT', 'WEEK', 'MONTH']);
export type PricePeriod = z.infer<typeof PricePeriod>;
/** CEE label (PLAN §13): A–G, or EXEMPT; PENDING means "in progress" and does not allow PUBLIC. */
export const CeeRating = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING']);
export type CeeRating = z.infer<typeof CeeRating>;
export const LocationPrecision = z.enum(['EXACT', 'APPROX']);
export type LocationPrecision = z.infer<typeof LocationPrecision>;

/** Fields an agent may lock against feed re-imports (PLAN §3 #18); manual edits are never blocked. */
export const LOCKABLE_LISTING_FIELDS = [
  'price',
  'commission',
  'split',
  'status',
  'specs',
  'energyRating',
  'coordinates',
  'propertyType',
  'location',
] as const;
export const LockableListingField = z.enum(LOCKABLE_LISTING_FIELDS);
export type LockableListingField = z.infer<typeof LockableListingField>;

/** Split of the commission for the collaborating agent: 0–100 % in basis points (PLAN §3 #7). */
export const SplitBp = z.number().int().min(0).max(MAX_SPLIT_BP);
/** `numeric(10,2)`: below 100,000,000 m². */
const Area = z.number().min(0).max(99_999_999.99);
const Count = z.number().int().min(0).max(1000);
const Coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

/** Every editable field of a listing; `null` clears a nullable one. Shared by create and update. */
const ListingFields = z.object({
  transactionType: TransactionType,
  propertyTypeId: z.uuid(),
  locationId: z.uuid(),
  priceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: CurrencyCode,
  pricePeriod: PricePeriod.nullable(),
  priceOnRequest: z.boolean(),
  /** Total commission: a percentage of the sale price or a fixed amount; default from agency settings. */
  commission: Commission,
  /** The collaborating agent's share; default from agency settings. */
  splitBp: SplitBp,
  builtM2: Area.nullable(),
  plotM2: Area.nullable(),
  terraceM2: Area.nullable(),
  bedrooms: Count.nullable(),
  bathrooms: Count.nullable(),
  yearBuilt: z.number().int().min(1000).max(3000).nullable(),
  energyRating: CeeRating.nullable(),
  energyEmissionsRating: CeeRating.nullable(),
  /** The exact position (kept private); the network and websites see it only when `locationPrecision` is EXACT. */
  coordinates: Coordinates.nullable(),
  locationPrecision: LocationPrecision,
  /** The responsible member; agents may only name themselves, admins any member of the agency. */
  ownerUserId: z.uuid(),
  cadastralRef: z.string().trim().max(40).nullable(),
  internalNotes: z.string().max(10_000).nullable(),
  keysInfo: z.string().max(2_000).nullable(),
  lockedFields: z.array(LockableListingField).max(LOCKABLE_LISTING_FIELDS.length),
});

/** `POST /v1/listings`: a DRAFT, PRIVATE listing. Only type and location are required. */
export const CreateListingBody = ListingFields.partial()
  .extend({
    transactionType: TransactionType.default('SALE'),
    propertyTypeId: z.uuid(),
    locationId: z.uuid(),
  })
  .strict();
export type CreateListingBody = z.infer<typeof CreateListingBody>;

/** `PATCH /v1/listings/:id`: the fields sent change, the rest stay; `version` is the one the caller read. */
export const UpdateListingBody = ListingFields.partial()
  .extend({
    version: z.number().int().min(1),
    status: ListingStatus.optional(),
    visibility: Visibility.optional(),
    shareScope: ShareScope.optional(),
  })
  .strict();
export type UpdateListingBody = z.infer<typeof UpdateListingBody>;

export const ListingParams = z.object({ id: z.uuid() }).strict();
export type ListingParams = z.infer<typeof ListingParams>;

/** An agency's own label on a listing (S3-07): trimmed, lower-case, no control characters. */
export const ListingTag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[^\p{C}]+$/u);
export type ListingTag = z.infer<typeof ListingTag>;

/** A flag in a query string (`true`/`false`) or in a JSON body or saved view (a boolean). */
const Flag = z.union([z.boolean(), z.stringbool()]);
const CentsFilter = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The listing list's filters (S3-07), shared by `GET /v1/listings`, saved views and bulk "all matching". Every
 * filter narrows the agency's own listings; `q` matches the start of the reference.
 */
export const ListingFilter = z
  .object({
    status: ListingStatus.optional(),
    visibility: Visibility.optional(),
    transactionType: TransactionType.optional(),
    propertyTypeId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    /** One member's listings (admins); `mine` is the caller's own (agents' default view). */
    ownerUserId: z.uuid().optional(),
    mine: Flag.optional(),
    /** Price range in cents, inclusive; listings without a price never match a range. */
    priceMin: CentsFilter.optional(),
    priceMax: CentsFilter.optional(),
    bedroomsMin: z.coerce.number().int().min(0).max(1000).optional(),
    tag: ListingTag.optional(),
    /** The start of the reference, case-insensitive. */
    q: z
      .string()
      .trim()
      .max(16)
      .regex(/^[A-Za-z0-9]*$/)
      .optional(),
  })
  .strict();
export type ListingFilter = z.infer<typeof ListingFilter>;

/** List orders: by creation (default newest first), last change, or price (listings without a price last). */
export const LISTING_SORTS = ['newest', 'oldest', 'updated', 'price_asc', 'price_desc'] as const;
export const ListingSort = z.enum(LISTING_SORTS);
export type ListingSort = z.infer<typeof ListingSort>;

export const ListListingsQuery = ListingFilter.extend({
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: ListingSort.default('newest'),
  /** Deleted listings that can still be restored (30 days), newest first (`sort` does not apply). */
  deleted: z.stringbool().optional(),
}).strict();
export type ListListingsQuery = z.infer<typeof ListListingsQuery>;

/** Fields only the owner agency sees (never other agencies, never a client). */
export const ListingPrivateDto = z.object({
  cadastralRef: z.string().nullable(),
  internalNotes: z.string().nullable(),
  keysInfo: z.string().nullable(),
  /** The exact position. */
  coordinates: Coordinates.nullable(),
  externalRef: z.string().nullable(),
  lockedFields: z.array(LockableListingField),
});
export type ListingPrivateDto = z.infer<typeof ListingPrivateDto>;

export const ListingDto = z.object({
  id: z.uuid(),
  /** Null in Client Mode for another agency's listing (white label): the client never learns the owner. */
  agencyId: z.uuid().nullable(),
  ownerUserId: z.uuid().nullable(),
  ref: z.string().nullable(),
  source: z.string(),
  status: ListingStatus,
  visibility: Visibility,
  shareScope: ShareScope,
  transactionType: TransactionType,
  price: Money.nullable(),
  pricePeriod: PricePeriod.nullable(),
  priceOnRequest: z.boolean(),
  /** Null in Client Mode (PLAN §3 #56): a client never sees commission or split. */
  commission: z.object({ total: Commission.nullable(), splitBp: z.number().int().nullable() }).nullable(),
  builtM2: z.number().nullable(),
  plotM2: z.number().nullable(),
  terraceM2: z.number().nullable(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  yearBuilt: z.number().int().nullable(),
  energyRating: CeeRating.nullable(),
  energyEmissionsRating: CeeRating.nullable(),
  /** The shown point: exact for EXACT, rounded (about 1 km) for APPROX. */
  coordinates: Coordinates.nullable(),
  locationPrecision: LocationPrecision,
  propertyTypeId: z.uuid(),
  locationId: z.uuid(),
  /** Owner agency only (null for other agencies and in Client Mode). */
  private: ListingPrivateDto.nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ListingDto = z.infer<typeof ListingDto>;

export const ListingSummaryDto = z.object({
  id: z.uuid(),
  ref: z.string(),
  ownerUserId: z.uuid(),
  status: ListingStatus,
  visibility: Visibility,
  transactionType: TransactionType,
  price: Money.nullable(),
  shareScope: ShareScope,
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  builtM2: z.number().nullable(),
  propertyTypeId: z.uuid(),
  locationId: z.uuid(),
  /** The agency's tags, sorted. */
  tags: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ListingSummaryDto = z.infer<typeof ListingSummaryDto>;
export const ListingPage = pageOf(ListingSummaryDto);
export type ListingPage = z.infer<typeof ListingPage>;

// ---- Saved views (S3-07): a member's named filters, sort and columns -----------------------------------------

/** Columns the listing list can show, in their default order; a view picks and orders them. */
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
export const ListingColumn = z.enum(LISTING_COLUMNS);
export type ListingColumn = z.infer<typeof ListingColumn>;
export const DEFAULT_LISTING_COLUMNS: readonly ListingColumn[] = [
  'ref',
  'type',
  'location',
  'price',
  'status',
  'visibility',
  'created',
];
/** Saved views per member. */
export const LISTING_VIEWS_MAX = 50;

export const ListingViewQuery = ListingFilter.extend({ sort: ListingSort.optional() }).strict();
export type ListingViewQuery = z.infer<typeof ListingViewQuery>;

/** `POST /v1/listing-views`, `PUT /v1/listing-views/:id`. */
export const ListingViewBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    query: ListingViewQuery,
    columns: z
      .array(ListingColumn)
      .min(1)
      .max(LISTING_COLUMNS.length)
      .refine((c) => new Set(c).size === c.length, 'duplicate column'),
  })
  .strict();
export type ListingViewBody = z.infer<typeof ListingViewBody>;

export const ListingViewDto = z.object({
  id: z.uuid(),
  name: z.string(),
  query: ListingViewQuery,
  columns: z.array(ListingColumn),
  updatedAt: z.iso.datetime(),
});
export type ListingViewDto = z.infer<typeof ListingViewDto>;
export const ListingViewList = z.object({ items: z.array(ListingViewDto) });
export type ListingViewList = z.infer<typeof ListingViewList>;
export const ListingViewParams = z.object({ id: z.uuid() }).strict();

// ---- Bulk actions (S3-07): one change to many listings, run as a job with progress ----------------------------

/** Listings one bulk action may change (an agency's whole inventory at the R1 scale). */
export const LISTING_BULK_MAX = 5_000;
/** Failures a bulk action keeps (listing + code); the counters cover all of them. */
export const LISTING_BULK_FAILURES_KEPT = 100;

/**
 * What to do to every listing. A price change is a percentage in basis points (−90 % … +100 %), rounded to a
 * whole unit of the listing's currency; listings without a price fail with LISTING_PRICE_MISSING.
 */
export const ListingBulkAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATUS'), status: ListingStatus }).strict(),
  z.object({ type: z.literal('VISIBILITY'), visibility: Visibility }).strict(),
  z.object({ type: z.literal('SHARE_SCOPE'), shareScope: ShareScope }).strict(),
  z
    .object({
      type: z.literal('PRICE_CHANGE'),
      percentBp: z
        .number()
        .int()
        .min(-9_000)
        .max(10_000)
        .refine((v) => v !== 0, 'zero change'),
    })
    .strict(),
  z.object({ type: z.literal('ASSIGN'), ownerUserId: z.uuid() }).strict(),
  z.object({ type: z.literal('ADD_TAG'), tag: ListingTag }).strict(),
]);
export type ListingBulkAction = z.infer<typeof ListingBulkAction>;
export type ListingBulkActionType = ListingBulkAction['type'];

/** `POST /v1/listing-bulk-actions`: the listings by id, or every listing matching a filter (≤ 5,000). */
export const StartListingBulkBody = z
  .object({
    action: ListingBulkAction,
    target: z.union([
      z
        .object({
          ids: z
            .array(z.uuid())
            .min(1)
            .max(LISTING_BULK_MAX)
            .refine((ids) => new Set(ids).size === ids.length, 'duplicate id'),
        })
        .strict(),
      z.object({ filter: ListingFilter }).strict(),
    ]),
  })
  .strict();
export type StartListingBulkBody = z.infer<typeof StartListingBulkBody>;

export const ListingBulkState = z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
export type ListingBulkState = z.infer<typeof ListingBulkState>;

export const ListingBulkDto = z.object({
  id: z.uuid(),
  action: ListingBulkAction,
  state: ListingBulkState,
  total: z.number().int(),
  processed: z.number().int(),
  /** Changed listings. */
  succeeded: z.number().int(),
  /** Listings that already were as asked. */
  unchanged: z.number().int(),
  failed: z.number().int(),
  /** The first `LISTING_BULK_FAILURES_KEPT` failures. */
  failures: z.array(z.object({ listingId: z.uuid(), code: z.string() })),
  /** Why the action stopped (state FAILED): FORBIDDEN (the member left), STALLED or INTERNAL. */
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ListingBulkDto = z.infer<typeof ListingBulkDto>;
export const ListingBulkParams = z.object({ id: z.uuid() }).strict();

// ---- Listing content (S3-05): translations per content locale and features, edited by the listing editor ------

/** HUMAN: written by a person; AI_DRAFT: machine translation not yet checked; REVIEWED: a person checked a draft. */
export const TranslationOrigin = z.enum(['HUMAN', 'AI_DRAFT', 'REVIEWED']);
export type TranslationOrigin = z.infer<typeof TranslationOrigin>;

/** A content locale code; the service accepts only the configured content locales (`VALIDATION_FAILED`). */
export const ContentLocaleCode = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const ListingSlug = z
  .string()
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const ListingTranslationDto = z.object({
  locale: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  origin: TranslationOrigin,
  /** A person fixed this text: machine translation never overwrites it. */
  locked: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type ListingTranslationDto = z.infer<typeof ListingTranslationDto>;

/** `GET /v1/listings/:id/content`: translations (by locale) and the feature ids; `version` is the listing's. */
export const ListingContentDto = z.object({
  listingId: z.uuid(),
  version: z.number().int(),
  translations: z.array(ListingTranslationDto),
  featureIds: z.array(z.uuid()),
});
export type ListingContentDto = z.infer<typeof ListingContentDto>;

export const ListingTranslationParams = z.object({ id: z.uuid(), locale: ContentLocaleCode }).strict();
export type ListingTranslationParams = z.infer<typeof ListingTranslationParams>;

/**
 * `PUT /v1/listings/:id/translations/:locale`: a person writes the text (an AI draft becomes REVIEWED). The slug
 * follows the title when not sent. Optimistic on the listing `version`, which the save bumps.
 */
export const PutListingTranslationBody = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).nullable().optional(),
    slug: ListingSlug.optional(),
    metaTitle: z.string().trim().max(70).nullable().optional(),
    metaDescription: z.string().trim().max(160).nullable().optional(),
    locked: z.boolean().optional(),
  })
  .strict();
export type PutListingTranslationBody = z.infer<typeof PutListingTranslationBody>;

/** `DELETE /v1/listings/:id/translations/:locale?version=`. */
export const ListingVersionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
export type ListingVersionQuery = z.infer<typeof ListingVersionQuery>;

/** Most features a listing carries. */
export const LISTING_FEATURES_MAX = 200;

/** `PUT /v1/listings/:id/features`: the whole set (taxonomy feature ids), replacing the current one. */
export const SetListingFeaturesBody = z
  .object({
    version: z.number().int().min(1),
    featureIds: z
      .array(z.uuid())
      .max(LISTING_FEATURES_MAX)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate'),
  })
  .strict();
export type SetListingFeaturesBody = z.infer<typeof SetListingFeaturesBody>;
