/** quality DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';

/**
 * What the listing quality score (S3-08, 0–100) is made of, each with its maximum points: photos (count), their
 * resolution, the description, translations into the agency's languages, location, CEE rating and freshness.
 */
export const QUALITY_COMPONENTS = {
  photos: 25,
  resolution: 10,
  description: 20,
  translations: 15,
  location: 10,
  energy: 10,
  freshness: 10,
} as const;
export type QualityComponentKey = keyof typeof QUALITY_COMPONENTS;
export const QualityComponentKey = z.enum(
  Object.keys(QUALITY_COMPONENTS) as [QualityComponentKey, ...QualityComponentKey[]],
);

/** Photos for full marks, the long edge a photo needs (px) and the description length (characters). */
export const QUALITY_PHOTOS_TARGET = 15;
export const QUALITY_MIN_LONG_EDGE_PX = 1280;
export const QUALITY_DESCRIPTION_TARGET = 800;

/** Fix-it hints, each pointing at the editor section that fixes it. */
export const QUALITY_HINT_CODES = [
  'PHOTOS_FEW',
  'PHOTOS_LOW_RES',
  'DESCRIPTION_SHORT',
  'TRANSLATIONS_MISSING',
  'LOCATION_MISSING',
  'LOCATION_APPROX',
  'ENERGY_RATING_MISSING',
  'CONFIRMATION_DUE',
  'NETWORK_HIDDEN',
] as const;
export const QualityHintCode = z.enum(QUALITY_HINT_CODES);
export type QualityHintCode = z.infer<typeof QualityHintCode>;

/** Editor sections (`#section-<key>`) a hint links to. */
export const QualitySection = z.enum(['media', 'translations', 'location', 'specs', 'freshness']);
export type QualitySection = z.infer<typeof QualitySection>;

export const QualityHint = z.object({
  code: QualityHintCode,
  section: QualitySection,
  /** Points the fix would add. */
  gain: z.number().int().min(0),
  /** Message parameters: counts, targets, days, missing locales. */
  params: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type QualityHint = z.infer<typeof QualityHint>;

export const ListingQualityDto = z.object({
  listingId: z.uuid(),
  score: z.number().int().min(0).max(100),
  components: z.array(z.object({ key: QualityComponentKey, points: z.number().int(), max: z.number().int() })),
  /** Biggest gain first. */
  hints: z.array(QualityHint),
  /** Photos still processing: their resolution counts once known. */
  pendingPhotos: z.number().int().min(0),
});
export type ListingQualityDto = z.infer<typeof ListingQualityDto>;
