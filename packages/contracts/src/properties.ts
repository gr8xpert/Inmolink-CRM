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

export const ListListingsQuery = z
  .object({
    cursor: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: ListingStatus.optional(),
    /** Only the caller's own listings (agents' default view). */
    mine: z.stringbool().optional(),
    /** Deleted listings that can still be restored (30 days). */
    deleted: z.stringbool().optional(),
  })
  .strict();
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
  bedrooms: z.number().int().nullable(),
  propertyTypeId: z.uuid(),
  locationId: z.uuid(),
  createdAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ListingSummaryDto = z.infer<typeof ListingSummaryDto>;
export const ListingPage = pageOf(ListingSummaryDto);
export type ListingPage = z.infer<typeof ListingPage>;

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
