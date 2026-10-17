/** search DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { DevelopmentStatus, Orientation, UnitStatus } from './developments';
import { ListingMediaKind, ListingRoomType, VideoProvider } from './media';
import { CeeRating, ListingStatus, LocationPrecision, PricePeriod, TransactionType } from './properties';

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
