/** search DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { Cursor, Money } from './common';
import { DevelopmentStatus, Orientation, UnitStatus } from './developments';
import { ListingMediaKind, ListingRoomType, VideoProvider } from './media';
import {
  CeeRating,
  ContentLocaleCode,
  ListingStatus,
  LocationPrecision,
  PricePeriod,
  TransactionType,
} from './properties';

/**
 * Read-model documents (S5-01, PATTERNS §14): what `listing_read_models.card` / `.detail` hold for one listing or
 * new-build unit in one content locale. Strict objects: a field not named here cannot be stored, so owner,
 * agency, commission and private data (cadastral reference, seller, notes, keys, the exact pin, feed references,
 * quality score) never reach a public path by accident. White-labelling (presenting agency, site reference
 * prefix, overrides) is applied per site when served (S7-02), never baked in.
 */

/** A taxonomy item in the document's locale (the fallback locale's name when it has none). */
export const ReadModelTaxon = z.strictObject({ id: z.uuid(), name: z.string(), slug: z.string() });
export type ReadModelTaxon = z.infer<typeof ReadModelTaxon>;

/** The location's lineage: country, region, city and area (null above the location's own level). */
export const ReadModelPlace = z.strictObject({
  country: ReadModelTaxon.nullable(),
  region: ReadModelTaxon.nullable(),
  city: ReadModelTaxon.nullable(),
  area: ReadModelTaxon.nullable(),
});
export type ReadModelPlace = z.infer<typeof ReadModelPlace>;

export const ReadModelPrice = z.strictObject({
  amountCents: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3),
  /** Rentals: what the price is per. */
  period: PricePeriod.nullable(),
  onRequest: z.boolean(),
});
export type ReadModelPrice = z.infer<typeof ReadModelPrice>;

/** Variant sizes of a processed image (`media` variants). */
export const READ_MODEL_IMAGE_SIZES = ['thumb', 'small', 'medium', 'large', 'og'] as const;

/**
 * A processed image or floor plan: storage keys of its public variants (`v{pipeline}/{publicId}/{size}.{ext}` in
 * the `media` bucket; the serializer prefixes the CDN). Unprocessed images are left out until processed.
 */
export const ReadModelImage = z.strictObject({
  kind: ListingMediaKind,
  cover: z.boolean(),
  alt: z.string().nullable(),
  room: ListingRoomType.nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  variants: z.strictObject(Object.fromEntries(READ_MODEL_IMAGE_SIZES.map((s) => [s, z.string()]))).partial(),
});
export type ReadModelImage = z.infer<typeof ReadModelImage>;

export const ReadModelVideo = z.strictObject({ kind: z.literal('VIDEO'), provider: VideoProvider, id: z.string() });
export type ReadModelVideo = z.infer<typeof ReadModelVideo>;

export const ReadModelMedia = z.union([ReadModelImage, ReadModelVideo]);
export type ReadModelMedia = z.infer<typeof ReadModelMedia>;

/** A point and how exact it is (listings: the shown point, never the private pin). */
export const ReadModelGeo = z.strictObject({
  lat: z.number(),
  lng: z.number(),
  precision: LocationPrecision,
});

const textFields = {
  title: z.string(),
  slug: z.string(),
  /** The locale the text is in when the listing has none in the document's locale (else null). */
  textLocale: z.string().nullable(),
};

const listingCard = {
  kind: z.literal('LISTING'),
  id: z.uuid(),
  ref: z.string(),
  status: ListingStatus,
  transactionType: TransactionType,
  price: ReadModelPrice,
  propertyType: ReadModelTaxon,
  place: ReadModelPlace,
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  builtM2: z.number().nullable(),
  plotM2: z.number().nullable(),
  geo: ReadModelGeo.nullable(),
  cover: ReadModelImage.nullable(),
  imageCount: z.number().int().nonnegative(),
  developmentId: z.uuid().nullable(),
  ...textFields,
};

export const ListingCardDoc = z.strictObject(listingCard);
export type ListingCardDoc = z.infer<typeof ListingCardDoc>;

export const ListingDetailDoc = z.strictObject({
  ...listingCard,
  description: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  terraceM2: z.number().nullable(),
  yearBuilt: z.number().int().nullable(),
  energyRating: CeeRating.nullable(),
  energyEmissionsRating: CeeRating.nullable(),
  features: z.array(ReadModelTaxon),
  media: z.array(ReadModelMedia),
});
export type ListingDetailDoc = z.infer<typeof ListingDetailDoc>;

const unitCard = {
  kind: z.literal('UNIT'),
  id: z.uuid(),
  ref: z.string(),
  status: UnitStatus,
  price: ReadModelPrice,
  propertyType: ReadModelTaxon,
  place: ReadModelPlace,
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  internalM2: z.number().nullable(),
  terraceM2: z.number().nullable(),
  plotM2: z.number().nullable(),
  floor: z.number().int().nullable(),
  orientation: Orientation.nullable(),
  geo: ReadModelGeo.nullable(),
  development: z.strictObject({
    id: z.uuid(),
    name: z.string(),
    status: DevelopmentStatus,
    completionDate: z.string().nullable(),
  }),
  /** The development's title and slug in the document's locale. */
  ...textFields,
};

export const UnitCardDoc = z.strictObject(unitCard);
export type UnitCardDoc = z.infer<typeof UnitCardDoc>;

export const UnitDetailDoc = z.strictObject({
  ...unitCard,
  description: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  phase: z
    .strictObject({ name: z.string(), status: DevelopmentStatus, completionDate: z.string().nullable() })
    .nullable(),
});
export type UnitDetailDoc = z.infer<typeof UnitDetailDoc>;

/**
 * Website search (S5-04, PLAN §5.4): the filters a public site sends, answered by the search engine or — when it is
 * down or slow — by the Postgres fallback (`backend`). Results are ids; callers hydrate read models. Only what a
 * visitor may choose: the site's inventory (owner agencies) is a separate, server-side argument from its policy
 * (S7-01), so a visitor can never ask which agency owns a listing.
 */
export const PUBLIC_SEARCH_SORTS = ['newest', 'price_asc', 'price_desc', 'beds_desc', 'area_desc'] as const;
export const PublicSearchSort = z.enum(PUBLIC_SEARCH_SORTS);
export type PublicSearchSort = z.infer<typeof PublicSearchSort>;

/** Facets a site may ask for (the engine only: the fallback answers none). */
export const PUBLIC_SEARCH_FACETS = ['propertyTypeId', 'locationIds', 'featureIds', 'beds', 'transactionType'] as const;
export const PublicSearchFacet = z.enum(PUBLIC_SEARCH_FACETS);

/** Statuses a visitor may filter on (listings and new-build units that are on the market). */
export const PUBLIC_SEARCH_STATUSES = ['ACTIVE', 'UNDER_OFFER', 'AVAILABLE', 'RESERVED'] as const;
export const PublicSearchStatus = z.enum(PUBLIC_SEARCH_STATUSES);

const Ids = (max: number) => z.array(z.uuid()).min(1).max(max);
const Amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Lat = z.number().min(-90).max(90);
const Lng = z.number().min(-180).max(180);

export const PublicListingSearch = z.strictObject({
  /** Full text in `locale` (engine); the fallback matches it against references only. */
  text: z.string().trim().min(1).max(100).optional(),
  locale: ContentLocaleCode,
  kind: z.enum(['LISTING', 'UNIT']).optional(),
  developmentId: z.uuid().optional(),
  /** Live statuses only: drafts, withdrawn and sold listings are not a visitor's to list. */
  statuses: z.array(PublicSearchStatus).min(1).max(PUBLIC_SEARCH_STATUSES.length).default(['ACTIVE', 'AVAILABLE']),
  transactionType: TransactionType.optional(),
  /** Any of these types. */
  propertyTypeIds: Ids(50).optional(),
  /** Anywhere under any of these locations. */
  locationIds: Ids(50).optional(),
  /** Every one of these features. */
  featureIds: Ids(20).optional(),
  priceMinCents: Amount.optional(),
  priceMaxCents: Amount.optional(),
  bedsMin: z.number().int().min(0).max(50).optional(),
  bathsMin: z.number().int().min(0).max(50).optional(),
  areaMinM2: z.number().min(0).max(1_000_000).optional(),
  areaMaxM2: z.number().min(0).max(1_000_000).optional(),
  /** Map view. */
  geoBox: z
    .strictObject({ north: Lat, west: Lng, south: Lat, east: Lng })
    .refine((b) => b.south <= b.north, { message: 'south must not be above north', path: ['south'] })
    .optional(),
  facets: z.array(PublicSearchFacet).max(PUBLIC_SEARCH_FACETS.length).default([]),
  sort: PublicSearchSort.default('newest'),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: Cursor.optional(),
});
export type PublicListingSearch = z.input<typeof PublicListingSearch>;

export const PublicListingSearchResult = z.object({
  ids: z.array(z.uuid()),
  /** Matching documents: exact up to 10,000 from the engine, 1,000 from the fallback (then that cap). */
  total: z.number().int(),
  /** Value → count per requested facet; empty from the fallback. */
  facets: z.record(z.string(), z.record(z.string(), z.number().int())),
  nextCursor: Cursor.nullable(),
  /** Who answered: the search engine, or the Postgres fallback (simpler ranking, no facets). */
  backend: z.enum(['engine', 'fallback']),
});
export type PublicListingSearchResult = z.infer<typeof PublicListingSearchResult>;

/**
 * Network search (S5-05, PLAN §3 #5 #7 #57, §7 M10): an agency's agents search the other agencies' SHARED and PUBLIC
 * listings and the new-build units shared with them, with the commission terms upfront. Never in Client Mode (it
 * shows owner agencies and commission). Listings are ACTIVE on the network, so `statuses` names unit statuses
 * besides ACTIVE.
 */
export const NETWORK_SEARCH_STATUSES = ['ACTIVE', 'AVAILABLE', 'RESERVED'] as const;
export const NetworkSearchStatus = z.enum(NETWORK_SEARCH_STATUSES);
/** Results per page (map view shows one page of pins). */
export const NETWORK_SEARCH_LIMIT_MAX = 50;

export const NetworkSearchBody = z.strictObject({
  /** Full text in the caller's locale: references, titles, places, descriptions. */
  text: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(['LISTING', 'UNIT']).optional(),
  /** New-build units only (developments shared with the caller or open to the network). */
  newBuilds: z.boolean().default(false),
  /** Only listings and units of the agencies on the caller's preferred list. */
  preferredOnly: z.boolean().default(false),
  statuses: z.array(NetworkSearchStatus).min(1).max(NETWORK_SEARCH_STATUSES.length).default(['ACTIVE', 'AVAILABLE']),
  transactionType: TransactionType.optional(),
  propertyTypeIds: Ids(50).optional(),
  locationIds: Ids(50).optional(),
  featureIds: Ids(20).optional(),
  priceMinCents: Amount.optional(),
  priceMaxCents: Amount.optional(),
  bedsMin: z.number().int().min(0).max(50).optional(),
  bathsMin: z.number().int().min(0).max(50).optional(),
  areaMinM2: z.number().min(0).max(1_000_000).optional(),
  areaMaxM2: z.number().min(0).max(1_000_000).optional(),
  /** Map view: the visible box. */
  geoBox: z
    .strictObject({ north: Lat, west: Lng, south: Lat, east: Lng })
    .refine((b) => b.south <= b.north, { message: 'south must not be above north', path: ['south'] })
    .optional(),
  sort: PublicSearchSort.default('newest'),
  limit: z.number().int().min(1).max(NETWORK_SEARCH_LIMIT_MAX).default(24),
  cursor: Cursor.optional(),
});
export type NetworkSearchBody = z.input<typeof NetworkSearchBody>;

/**
 * Give-to-get (PLAN §3 #5): network search needs `threshold` ACTIVE listings shared with the network. OPEN: enough
 * shared · GRACE: a new agency, until `graceEndsAt` · EXEMPT: a buyer-only agency staff exempted · LOCKED: none of
 * these — the caller sees the upsell, not results. `sharedListings` is counted up to the threshold.
 */
export const GiveToGetState = z.enum(['OPEN', 'GRACE', 'EXEMPT', 'LOCKED']);
export type GiveToGetState = z.infer<typeof GiveToGetState>;
export const GiveToGetGate = z.object({
  state: GiveToGetState,
  sharedListings: z.number().int(),
  threshold: z.number().int(),
  graceEndsAt: z.iso.datetime(),
});
export type GiveToGetGate = z.infer<typeof GiveToGetGate>;

/**
 * A result's commission (PLAN §3 #7), from the listing's or unit's own values: the total (a percentage of the price
 * or a fixed amount), the collaborating agent's share (`splitBp`; a developer pays a unit's commission whole, 10000)
 * and what the caller earns — price × total × split, or the fixed amount × split, rounded down to the cent; null
 * when the price is on request.
 */
export const NetworkCommission = z.object({
  type: z.enum(['PCT', 'FIXED']),
  totalBp: z.number().int().nullable(),
  fixed: Money.nullable(),
  /** Null when the listing names no split (then no earnings either). */
  splitBp: z.number().int().nullable(),
  includesVat: z.boolean(),
  viewerEarnings: Money.nullable(),
});
export type NetworkCommission = z.infer<typeof NetworkCommission>;

export const NetworkSearchItem = z.object({
  id: z.uuid(),
  kind: z.enum(['LISTING', 'UNIT']),
  card: z.union([ListingCardDoc, UnitCardDoc]),
  /** The listing agent (agent side only: never shown to a client). */
  ownerAgency: z.object({ id: z.uuid(), name: z.string() }),
  /** The owner is on the caller's preferred list. */
  preferred: z.boolean(),
  /** Null when the listing names no commission. */
  commission: NetworkCommission.nullable(),
});
export type NetworkSearchItem = z.infer<typeof NetworkSearchItem>;

export const NetworkSearchResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('LOCKED'), gate: GiveToGetGate }),
  z.object({
    status: z.literal('OK'),
    gate: GiveToGetGate,
    items: z.array(NetworkSearchItem),
    /**
     * Approximate (S6-F1): the engine's estimate of the matching index documents, ≤ 10,000. Results the caller may not
     * read under RLS (a listing hidden for freshness, an owner that is suspended or unlisted, a share just narrowed)
     * are still counted here but left out of the page, so pages can be short and the total can exceed what paging
     * reaches. Show it as "about N".
     */
    total: z.number().int(),
    nextCursor: Cursor.nullable(),
  }),
]);
export type NetworkSearchResult = z.infer<typeof NetworkSearchResult>;
