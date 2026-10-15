/** taxonomy DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */
import { z } from 'zod';
import { Cursor, pageOf } from './common';

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

/** A set of translations as staff write it: each locale once (a repeat would collide on the (id, locale) key). */
const Translations = z
  .array(TranslationInput)
  .min(1)
  .max(40)
  .refine((ts) => new Set(ts.map((t) => t.locale)).size === ts.length, { message: 'Each locale once' });

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
  translations: Translations,
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
  translations: Translations,
  memberIds: z.array(z.uuid()).max(500).default([]),
});
export type CreateLocationGroupInput = z.infer<typeof CreateLocationGroupInput>;

const Key = Slug.max(80);

export const CreateTypeGroupInput = z.object({
  key: Key,
  sort: z.number().int().min(0).max(32000).default(0),
  translations: Translations,
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

// ---- Staff admin (S2-04) -----------------------------------------------------------------------------------------

export const StaffLocationAlias = z.object({ id: z.uuid(), alias: z.string() });

/** One location as staff edit it: every translation, aliases and geometry (GeoJSON), not the localized view. */
export const StaffLocationDto = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  level: LocationLevel,
  code: z.string().nullable(),
  sort: z.number().int(),
  centroid: GeoPoint.nullable(),
  polygon: GeoMultiPolygon.nullable(),
  translations: z.array(TranslationInput),
  aliases: z.array(StaffLocationAlias),
});
export type StaffLocationDto = z.infer<typeof StaffLocationDto>;

/** Only what is sent changes. `translations` replaces the set (a locale left out is removed, one must remain). */
export const UpdateLocationInput = z
  .object({
    code: z.string().trim().min(1).max(40).nullable(),
    centroid: GeoPoint.nullable(),
    polygon: GeoMultiPolygon.nullable(),
    translations: Translations,
  })
  .partial();
export type UpdateLocationInput = z.infer<typeof UpdateLocationInput>;

/** The complete, new order of one parent's children (or of the roots when `parentId` is null). */
export const ReorderLocationsInput = z.object({
  parentId: z.uuid().nullable(),
  orderedIds: z.array(z.uuid()).min(1).max(2000),
});
export type ReorderLocationsInput = z.infer<typeof ReorderLocationsInput>;

export const CatalogKind = z.enum(['propertyType', 'feature']);
export type CatalogKind = z.infer<typeof CatalogKind>;

/** The complete, new order of the groups of one kind, or of the items of one group. */
export const ReorderCatalogInput = z.object({
  kind: CatalogKind,
  groupId: z.uuid().nullable(),
  orderedIds: z.array(z.uuid()).min(1).max(1000),
});
export type ReorderCatalogInput = z.infer<typeof ReorderCatalogInput>;

/** `scope` says whether the id is a group or an item of `kind`. */
export const UpdateCatalogItemInput = z.object({
  kind: CatalogKind,
  scope: z.enum(['group', 'item']),
  translations: Translations,
});
export type UpdateCatalogItemInput = z.infer<typeof UpdateCatalogItemInput>;

export const AddAliasInput = z.object({ alias: z.string().trim().min(1).max(200) });
export type AddAliasInput = z.infer<typeof AddAliasInput>;

export const IdDto = z.object({ id: z.uuid() });
export const AliasParams = z.object({ id: z.uuid(), aliasId: z.uuid() }).strict();

/** A property type, feature or one of their groups as staff edit it: all translations (and aliases of an item). */
export const StaffCatalogItemDto = z.object({
  id: z.uuid(),
  kind: CatalogKind,
  scope: z.enum(['group', 'item']),
  translations: z.array(TranslationInput),
  aliases: z.array(StaffLocationAlias),
});
export type StaffCatalogItemDto = z.infer<typeof StaffCatalogItemDto>;

export const CatalogItemParams = z
  .object({ kind: CatalogKind, scope: z.enum(['group', 'item']), id: z.uuid() })
  .strict();
export const CatalogAliasParams = z.object({ kind: CatalogKind, id: z.uuid(), aliasId: z.uuid() }).strict();
export const CatalogKindParams = z.object({ kind: CatalogKind, id: z.uuid() }).strict();

// ---- Unmatched feed values (S2-05) ---------------------------------------------------------------------------

export const UnmatchedKind = z.enum(['location', 'propertyType', 'feature']);
export type UnmatchedKind = z.infer<typeof UnmatchedKind>;
export const UnmatchedStatus = z.enum(['OPEN', 'MAPPED', 'IGNORED']);
export type UnmatchedStatus = z.infer<typeof UnmatchedStatus>;

/** One queued feed value: how often it was seen, examples, and the closest candidate (a hint, never applied). */
export const UnmatchedDto = z.object({
  id: z.uuid(),
  kind: UnmatchedKind,
  value: z.string(),
  count: z.number().int(),
  examples: z.array(z.string()),
  candidate: z.object({ id: z.uuid(), name: z.string(), confidence: z.number() }).nullable(),
  status: UnmatchedStatus,
  mappedToId: z.uuid().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type UnmatchedDto = z.infer<typeof UnmatchedDto>;

export const UnmatchedPageDto = pageOf(UnmatchedDto);
export type UnmatchedPageDto = z.infer<typeof UnmatchedPageDto>;

/** Most-seen first. `status` defaults to the open queue. */
export const UnmatchedListQuery = z.object({
  kind: UnmatchedKind.optional(),
  status: UnmatchedStatus.default('OPEN'),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type UnmatchedListQuery = z.infer<typeof UnmatchedListQuery>;

/** The location, property type or feature the value means (its kind is the queue row's). */
export const MapUnmatchedInput = z.object({ targetId: z.uuid() });
export type MapUnmatchedInput = z.infer<typeof MapUnmatchedInput>;
