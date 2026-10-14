/** taxonomy DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';

export const LocationLevel = z.enum(['COUNTRY', 'REGION', 'CITY', 'AREA']);
export type LocationLevel = z.infer<typeof LocationLevel>;

const Slug = z
  .string()
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const TranslationInput = z.object({
  locale: z.string().min(2).max(10),
  name: z.string().trim().min(1).max(200),
  slug: Slug,
});
export type TranslationInput = z.infer<typeof TranslationInput>;

const Position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** GeoJSON in WGS84 (lon, lat). */
export const GeoPoint = z.object({ type: z.literal('Point'), coordinates: Position });
export const GeoMultiPolygon = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(z.array(Position).min(4)).min(1)).min(1),
});

export const CreateLocationInput = z.object({
  parentId: z.uuid().nullable(),
  level: LocationLevel,
  code: z.string().trim().min(1).max(40).optional(),
  centroid: GeoPoint.optional(),
  polygon: GeoMultiPolygon.optional(),
  translations: z.array(TranslationInput).min(1).max(40),
});
export type CreateLocationInput = z.infer<typeof CreateLocationInput>;

export const LocationDto = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  level: LocationLevel,
  code: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
});
export type LocationDto = z.infer<typeof LocationDto>;

export const PointLookupQuery = z.object({
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
});
export type PointLookupQuery = z.infer<typeof PointLookupQuery>;

export const CreateLocationGroupInput = z.object({
  key: Slug.max(80),
  translations: z.array(TranslationInput).min(1).max(40),
  memberIds: z.array(z.uuid()).max(500).default([]),
});
export type CreateLocationGroupInput = z.infer<typeof CreateLocationGroupInput>;

const Key = Slug.max(80);

export const CreateTypeGroupInput = z.object({
  key: Key,
  sort: z.number().int().min(0).max(32000).default(0),
  translations: z.array(TranslationInput).min(1).max(40),
});
export type CreateTypeGroupInput = z.infer<typeof CreateTypeGroupInput>;

export const CreatePropertyTypeInput = CreateTypeGroupInput.extend({ groupId: z.uuid() });
export type CreatePropertyTypeInput = z.infer<typeof CreatePropertyTypeInput>;

/** A Lucide icon name, kebab-case. */
export const LucideIcon = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const CreateFeatureInput = CreatePropertyTypeInput.extend({ icon: LucideIcon });
export type CreateFeatureInput = z.infer<typeof CreateFeatureInput>;

export const PropertyTypeDto = z.object({
  id: z.uuid(),
  groupId: z.uuid(),
  key: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type PropertyTypeDto = z.infer<typeof PropertyTypeDto>;

export const FeatureDto = PropertyTypeDto.extend({ icon: z.string() });
export type FeatureDto = z.infer<typeof FeatureDto>;
