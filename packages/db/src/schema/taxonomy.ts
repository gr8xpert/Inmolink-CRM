/**
 * Tables owned by the taxonomy module (PATTERNS §2). Only `packages/core/src/modules/taxonomy` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { sql } from 'drizzle-orm';
import {
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
