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

// ---- Localized taxonomy tree (S2-03): one cached read for the dashboard UI and the website API ----------------

const TreeLocation = z.object({
  id: z.uuid(),
  level: LocationLevel,
  code: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
});
/** AREA → CITY → REGION → COUNTRY: the depth is fixed at 4, so each level is its own schema (no recursion). */
export const TaxonomyArea = TreeLocation;
export const TaxonomyCity = TreeLocation.extend({ children: z.array(TaxonomyArea) });
export const TaxonomyRegion = TreeLocation.extend({ children: z.array(TaxonomyCity) });
export const TaxonomyCountry = TreeLocation.extend({ children: z.array(TaxonomyRegion) });
export type TaxonomyCountry = z.infer<typeof TaxonomyCountry>;

export const TaxonomyLocationGroup = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  slug: z.string(),
  locationIds: z.array(z.uuid()),
});

const TreeItem = z.object({ id: z.uuid(), key: z.string(), name: z.string(), slug: z.string() });
export const TaxonomyPropertyTypeGroup = TreeItem.extend({ types: z.array(TreeItem) });
export const TaxonomyFeatureGroup = TreeItem.extend({ features: z.array(TreeItem.extend({ icon: z.string() })) });

/** Locations (tree) and location groups. Names and slugs in `locale`, else the fallback content locale, else any. */
export const TaxonomyLocationsDto = z.object({
  locale: z.string(),
  locations: z.array(TaxonomyCountry),
  locationGroups: z.array(TaxonomyLocationGroup),
});
export type TaxonomyLocationsDto = z.infer<typeof TaxonomyLocationsDto>;

/** Property types and features, grouped and sorted (`sort`, then key). */
export const TaxonomyCatalogDto = z.object({
  locale: z.string(),
  propertyTypes: z.array(TaxonomyPropertyTypeGroup),
  features: z.array(TaxonomyFeatureGroup),
});
export type TaxonomyCatalogDto = z.infer<typeof TaxonomyCatalogDto>;

/** The whole localized taxonomy (dashboard UI). */
export const TaxonomyDto = TaxonomyLocationsDto.extend(TaxonomyCatalogDto.shape);
export type TaxonomyDto = z.infer<typeof TaxonomyDto>;

// Website API: the tree is served one level at a time, so every response stays small however many
// locations there are (feed-api budget ≤ 150 KB gzip; a Spain-sized tree is ~330 KB gzip whole).

/** A location with the number of its children (0 for areas): fetch them with `/v2/taxonomy/locations/{id}/children`. */
export const WebsiteLocation = TreeLocation.extend({ childCount: z.number().int().min(0) });

/** Countries with their regions, and the location groups. */
export const WebsiteLocationsDto = z.object({
  locale: z.string(),
  locations: z.array(WebsiteLocation.extend({ children: z.array(WebsiteLocation) })),
  locationGroups: z.array(TaxonomyLocationGroup),
});
export type WebsiteLocationsDto = z.infer<typeof WebsiteLocationsDto>;

/** The direct children of one location (a region's cities, a city's areas). */
export const WebsiteLocationChildrenDto = z.object({
  locale: z.string(),
  parentId: z.uuid(),
  children: z.array(WebsiteLocation),
});
export type WebsiteLocationChildrenDto = z.infer<typeof WebsiteLocationChildrenDto>;

/** `?lang=` of the website API: a content locale (unsupported → 422); absent → the default content locale. */
export const TaxonomyLangQuery = z.object({
  lang: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
    .optional(),
});

export const LocationParams = z.object({ id: z.uuid() }).strict();
