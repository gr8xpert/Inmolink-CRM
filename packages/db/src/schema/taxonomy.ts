/**
 * Tables owned by the taxonomy module (PATTERNS §2). Only `packages/core/src/modules/taxonomy` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** PostGIS geometry in WGS84. Written and read through `ST_*` SQL (GeoJSON in, GeoJSON out), never as raw hex. */
const point = customType<{ data: string }>({ dataType: () => 'geometry(Point,4326)' });
const multiPolygon = customType<{ data: string }>({ dataType: () => 'geometry(MultiPolygon,4326)' });

export const LOCATION_LEVELS = ['COUNTRY', 'REGION', 'CITY', 'AREA'] as const;

/**
 * Platform-wide location tree (PLAN §6, S2-01): COUNTRY → REGION → CITY → AREA. Reference data shared by
 * every agency (global table, written by staff/scripts via `withSystem()`). `depth` (1–4) mirrors `level`
 * so the deepest match of a point is one indexed query.
 */
export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey(),
    parentId: uuid('parent_id'),
    level: text('level').notNull(),
    depth: smallint('depth').notNull(),
    /** Stable machine key (e.g. ISO code or import id); optional. */
    code: text('code'),
    centroid: point('centroid'),
    polygon: multiPolygon('polygon'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: 'locations_parent_fk' }).onDelete('restrict'),
    // Target of the (id, parent_id) FK from translations, so a slug is unique per parent.
    unique('locations_id_parent_uq').on(t.id, t.parentId),
    check('locations_level_ck', sql`${t.level} in ('COUNTRY','REGION','CITY','AREA')`),
    check(
      'locations_depth_ck',
      sql`${t.depth} = case ${t.level} when 'COUNTRY' then 1 when 'REGION' then 2 when 'CITY' then 3 else 4 end`,
    ),
    check('locations_root_ck', sql`(${t.level} = 'COUNTRY') = (${t.parentId} is null)`),
    uniqueIndex('locations_code_uq').on(t.code).where(sql`${t.code} is not null`),
    index('locations_parent_idx').on(t.parentId),
    index('locations_polygon_gix').using('gist', t.polygon),
    index('locations_centroid_gix').using('gist', t.centroid),
  ],
);

/** Name and per-locale slug. `parent_id` mirrors the location's (composite FK, cascading) to scope slug uniqueness. */
export const locationTranslations = pgTable(
  'location_translations',
  {
    locationId: uuid('location_id').notNull(),
    parentId: uuid('parent_id'),
    locale: text('locale').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.locationId, t.locale] }),
    foreignKey({
      columns: [t.locationId, t.parentId],
      foreignColumns: [locations.id, locations.parentId],
      name: 'location_translations_location_fk',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    // Slug unique per (parent, locale); roots (no parent) have their own index because NULLs never collide.
    uniqueIndex('location_translations_slug_uq').on(t.parentId, t.locale, t.slug).where(sql`${t.parentId} is not null`),
    uniqueIndex('location_translations_root_slug_uq').on(t.locale, t.slug).where(sql`${t.parentId} is null`),
    check('location_translations_slug_ck', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/** Feed spelling → canonical location. `alias_key` is the normalised spelling (lowercase, no accents). */
export const locationAliases = pgTable(
  'location_aliases',
  {
    id: uuid('id').primaryKey(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    aliasKey: text('alias_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('location_aliases_key_uq').on(t.aliasKey),
    index('location_aliases_location_idx').on(t.locationId),
  ],
);

/** Curated sets such as "Costa del Sol". */
export const locationGroups = pgTable('location_groups', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const locationGroupTranslations = pgTable(
  'location_group_translations',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => locationGroups.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.locale] }),
    uniqueIndex('location_group_translations_slug_uq').on(t.locale, t.slug),
    check('location_group_translations_slug_ck', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const locationGroupMembers = pgTable(
  'location_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => locationGroups.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.locationId] }),
    index('location_group_members_location_idx').on(t.locationId),
  ],
);

// ---- Property types and features (S2-02) ----------------------------------------------------------------
// Global reference data, same shape twice: group → item, uniform translation tables (name + slug per locale)
// and feed-spelling aliases. Built by factories so the two families cannot drift apart.

const SLUG_RE = sql.raw(`'^[a-z0-9]+(-[a-z0-9]+)*$'`);

function groupTable(name: string) {
  return pgTable(
    name,
    {
      id: uuid('id').primaryKey(),
      key: text('key').notNull().unique(),
      sort: smallint('sort').notNull().default(0),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    () => [],
  );
}

function translationTable(name: string, ownerCol: string, owner: () => AnyPgColumn) {
  return pgTable(
    name,
    {
      ownerId: uuid(ownerCol).notNull().references(owner, { onDelete: 'cascade' }),
      locale: text('locale').notNull(),
      name: text('name').notNull(),
      slug: text('slug').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.ownerId, t.locale], name: `${name}_pk` }),
      uniqueIndex(`${name}_slug_uq`).on(t.locale, t.slug),
      check(`${name}_slug_ck`, sql`${t.slug} ~ ${SLUG_RE}`),
    ],
  );
}

function aliasTable(name: string, owner: () => AnyPgColumn) {
  return pgTable(
    name,
    {
      id: uuid('id').primaryKey(),
      ownerId: uuid('owner_id').notNull().references(owner, { onDelete: 'cascade' }),
      alias: text('alias').notNull(),
      /** Normalised spelling: lowercase, no accents, single-spaced. */
      aliasKey: text('alias_key').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [uniqueIndex(`${name}_key_uq`).on(t.aliasKey), index(`${name}_owner_idx`).on(t.ownerId)],
  );
}

export const propertyTypeGroups = groupTable('property_type_groups');
export const propertyTypeGroupTranslations = translationTable(
  'property_type_group_translations',
  'group_id',
  () => propertyTypeGroups.id,
);

export const propertyTypes = pgTable(
  'property_types',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => propertyTypeGroups.id, { onDelete: 'restrict' }),
    key: text('key').notNull().unique(),
    sort: smallint('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('property_types_group_idx').on(t.groupId)],
);
export const propertyTypeTranslations = translationTable(
  'property_type_translations',
  'type_id',
  () => propertyTypes.id,
);
export const propertyTypeAliases = aliasTable('property_type_aliases', () => propertyTypes.id);

export const featureGroups = groupTable('feature_groups');
export const featureGroupTranslations = translationTable(
  'feature_group_translations',
  'group_id',
  () => featureGroups.id,
);

export const features = pgTable(
  'features',
  {
    id: uuid('id').primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => featureGroups.id, { onDelete: 'restrict' }),
    key: text('key').notNull().unique(),
    /** Lucide icon name, kebab-case (e.g. `waves`, `car-front`). */
    icon: text('icon').notNull(),
    sort: smallint('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('features_group_idx').on(t.groupId), check('features_icon_ck', sql`${t.icon} ~ ${SLUG_RE}`)],
);
export const featureTranslations = translationTable('feature_translations', 'feature_id', () => features.id);
export const featureAliases = aliasTable('feature_aliases', () => features.id);
