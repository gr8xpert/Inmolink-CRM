/** properties DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { Commission, MAX_SPLIT_BP } from './agency-profile';
import { CurrencyCode, Money, pageOf } from './common';
import {
  LISTING_COLUMNS,
  LISTING_SORTS,
  LISTING_STATUSES,
  LISTING_TAG_MAX,
  SHARE_SCOPES,
  TRANSACTION_TYPES,
  VISIBILITIES,
} from './values';

export const ListingStatus = z.enum(LISTING_STATUSES);
export type ListingStatus = z.infer<typeof ListingStatus>;
/** PLAN §3 #4: PRIVATE (owner) / SHARED (verified agents) / PUBLIC (marketplace, websites, portals). */
export const Visibility = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof Visibility>;
/** PLAN §3 #57: a shared listing reaches every verified agency, or only the agencies the owner prefers. */
export const ShareScope = z.enum(SHARE_SCOPES);
export type ShareScope = z.infer<typeof ShareScope>;
export const TransactionType = z.enum(TRANSACTION_TYPES);
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
  'features',
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
  .max(LISTING_TAG_MAX)
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

/** Freshness (S3-08): the agent is prompted 90 days after the last confirmation; at 120 the network hides it. */
export const LISTING_CONFIRM_PROMPT_DAYS = 90;
export const LISTING_NETWORK_HIDE_DAYS = 120;

/** When the listing was last confirmed as still on the market, and what follows when. */
export const ListingFreshnessDto = z.object({
  lastConfirmedAt: z.iso.datetime(),
  /** The confirmation prompt shows from here. */
  confirmDueAt: z.iso.datetime(),
  /** The listing leaves the network from here unless confirmed. */
  hideAt: z.iso.datetime(),
  /** Set while the listing is hidden from the network for want of a confirmation. */
  networkHiddenAt: z.iso.datetime().nullable(),
});
export type ListingFreshnessDto = z.infer<typeof ListingFreshnessDto>;

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
  /** 0–100 (S3-08), recomputed in the background after each change; null until first computed or in Client Mode. */
  qualityScore: z.number().int().min(0).max(100).nullable(),
  /** Owner agency only (null for other agencies and in Client Mode). */
  freshness: ListingFreshnessDto.nullable(),
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
export const ListingColumn = z.enum(LISTING_COLUMNS);
export type ListingColumn = z.infer<typeof ListingColumn>;
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

// ---- Bookmarks (S3-09): a member's folders of saved listings, with notes -------------------------------------

/** Folders per member. */
export const BOOKMARK_FOLDERS_MAX = 100;
/** Listings per folder: also the most a selection made from a folder starts with (S12-04). */
export const BOOKMARKS_PER_FOLDER_MAX = 500;

/** `POST /v1/bookmark-folders`, `PUT /v1/bookmark-folders/:id`. */
export const BookmarkFolderBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();
export type BookmarkFolderBody = z.infer<typeof BookmarkFolderBody>;

export const BookmarkFolderDto = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Bookmarks in the folder, unavailable ones included. */
  count: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type BookmarkFolderDto = z.infer<typeof BookmarkFolderDto>;
export const BookmarkFolderList = z.object({ items: z.array(BookmarkFolderDto) });
export type BookmarkFolderList = z.infer<typeof BookmarkFolderList>;
export const BookmarkFolderParams = z.object({ id: z.uuid() }).strict();

const BookmarkNote = z.string().trim().max(1000);

/** `POST /v1/bookmarks`: save a listing the caller can see into one of their folders. */
export const CreateBookmarkBody = z
  .object({ folderId: z.uuid(), listingId: z.uuid(), note: BookmarkNote.nullable().optional() })
  .strict();
export type CreateBookmarkBody = z.infer<typeof CreateBookmarkBody>;

/** `PATCH /v1/bookmarks/:id`: change the note or move it to another folder. */
export const UpdateBookmarkBody = z
  .object({ folderId: z.uuid().optional(), note: BookmarkNote.nullable().optional() })
  .strict()
  .refine((b) => b.folderId !== undefined || b.note !== undefined, 'nothing to change');
export type UpdateBookmarkBody = z.infer<typeof UpdateBookmarkBody>;
export const BookmarkParams = z.object({ id: z.uuid() }).strict();

/** The saved listing as the caller sees it now; the owner agency is never named. */
export const BookmarkedListingDto = z.object({
  ref: z.string(),
  status: ListingStatus,
  transactionType: TransactionType,
  price: Money.nullable(),
  bedrooms: z.number().int().nullable(),
  builtM2: z.number().nullable(),
  propertyTypeId: z.uuid(),
  locationId: z.uuid(),
  /** The caller's agency owns it. */
  own: z.boolean(),
});
export type BookmarkedListingDto = z.infer<typeof BookmarkedListingDto>;

export const BookmarkDto = z.object({
  id: z.uuid(),
  folderId: z.uuid(),
  listingId: z.uuid(),
  note: z.string().nullable(),
  /** False when the listing left the caller's view (unshared, sold off the network, deleted): `listing` is null. */
  available: z.boolean(),
  listing: BookmarkedListingDto.nullable(),
  createdAt: z.iso.datetime(),
});
export type BookmarkDto = z.infer<typeof BookmarkDto>;
export const BookmarkPage = pageOf(BookmarkDto);
export type BookmarkPage = z.infer<typeof BookmarkPage>;

/** `GET /v1/bookmark-folders/:id/bookmarks`: newest first, keyset. */
export const ListBookmarksQuery = z
  .object({
    cursor: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListBookmarksQuery = z.infer<typeof ListBookmarksQuery>;

/** `GET /v1/listings/:id/bookmarks`: the caller's bookmarks of one listing (one per folder at most). */
export const ListingBookmarkDto = z.object({ id: z.uuid(), folderId: z.uuid(), note: z.string().nullable() });
export type ListingBookmarkDto = z.infer<typeof ListingBookmarkDto>;
export const ListingBookmarkList = z.object({ items: z.array(ListingBookmarkDto) });
export type ListingBookmarkList = z.infer<typeof ListingBookmarkList>;

// ---- Listing overrides (S3-10, PLAN §3 #54): an agency's own text for listings it presents -------------------

/** A network listing, a new-build development or one of its units. */
export const ListingOverrideTarget = z.enum(['LISTING', 'DEVELOPMENT', 'UNIT']);
export type ListingOverrideTarget = z.infer<typeof ListingOverrideTarget>;

/** The agency's override of one target in one content locale; a null field shows the owner's text. */
export const ListingOverrideDto = z.object({
  targetKind: ListingOverrideTarget,
  targetId: z.uuid(),
  locale: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  origin: TranslationOrigin,
  updatedAt: z.iso.datetime(),
});
export type ListingOverrideDto = z.infer<typeof ListingOverrideDto>;
export const ListingOverrideList = z.object({ items: z.array(ListingOverrideDto) });
export type ListingOverrideList = z.infer<typeof ListingOverrideList>;

/** `GET /v1/listing-overrides/:targetKind/:targetId`: the caller's overrides of one target, every locale. */
export const ListingOverrideTargetParams = z.object({ targetKind: ListingOverrideTarget, targetId: z.uuid() }).strict();
export type ListingOverrideTargetParams = z.infer<typeof ListingOverrideTargetParams>;
/** `PUT|DELETE /v1/listing-overrides/:targetKind/:targetId/:locale`. */
export const ListingOverrideParams = z
  .object({ targetKind: ListingOverrideTarget, targetId: z.uuid(), locale: ContentLocaleCode })
  .strict();
export type ListingOverrideParams = z.infer<typeof ListingOverrideParams>;

/** `PUT …/:locale`: the whole override for the locale; an empty or null field keeps the owner's text. */
export const PutListingOverrideBody = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(20_000).nullable().optional(),
  })
  .strict()
  .refine((b) => Boolean(b.title) || Boolean(b.description), {
    message: 'Override the title, the description or both',
    path: ['title'],
  });
export type PutListingOverrideBody = z.infer<typeof PutListingOverrideBody>;
