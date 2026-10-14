/**
 * Tables owned by the taxonomy module (PATTERNS §2). Only `packages/core/src/modules/taxonomy` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
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

/**
 * The spelling a name is matched on in SQL (S2-05): lowercase, Latin accents folded, punctuation as single
 * spaces — the SQL twin of `aliasKey()` for the languages we serve. Immutable, so it can back an index.
 */
export const nameKey = (name: AnyPgColumn | SQL) =>
  sql`btrim(regexp_replace(translate(lower(${name}), 'áàâäãåéèêëíìîïóòôöõúùûüñçß', 'aaaaaaeeeeiiiiooooouuuunc'), '[^[:alnum:]]+', ' ', 'g'))`;

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
    /** Position among siblings, set by staff drag-and-drop (S2-04); ties break on the localized name. */
    sort: smallint('sort').notNull().default(0),
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
    index('location_translations_name_key_idx').using('gin', sql`${nameKey(t.name)} gin_trgm_ops`),
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
    // fuzzy fallback of the alias resolver (S2-05): `alias_key % $1`
    index('location_aliases_key_trgm_idx').using('gin', sql`${t.aliasKey} gin_trgm_ops`),
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

/** `fuzzy`: items the alias resolver matches names of (S2-05) get a trigram index; groups do not. */
function translationTable(name: string, ownerCol: string, owner: () => AnyPgColumn, fuzzy = false) {
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
      ...(fuzzy ? [index(`${name}_name_key_idx`).using('gin', sql`${nameKey(t.name)} gin_trgm_ops`)] : []),
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
    (t) => [
      uniqueIndex(`${name}_key_uq`).on(t.aliasKey),
      index(`${name}_owner_idx`).on(t.ownerId),
      index(`${name}_key_trgm_idx`).using('gin', sql`${t.aliasKey} gin_trgm_ops`),
    ],
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
  true,
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
export const featureTranslations = translationTable('feature_translations', 'feature_id', () => features.id, true);
export const featureAliases = aliasTable('feature_aliases', () => features.id);

// ---- Unmatched feed values (S2-05) ----------------------------------------------------------------------
/**
 * Feed values the resolver could not map with confidence (PLAN §7 M4: never silently dropped, never
 * guessed). One row per (kind, normalised spelling), counted across imports; staff map it (which creates
 * an alias) or ignore it. Global like the rest of the taxonomy; workers write via `withSystem()`.
 */
export const taxonomyUnmatched = pgTable(
  'taxonomy_unmatched',
  {
    id: uuid('id').primaryKey(),
    /** `location`, `propertyType` or `feature`. */
    kind: text('kind').notNull(),
    /** `aliasKey(value)`: the spelling the resolver matched on. */
    valueKey: text('value_key').notNull(),
    /** First spelling seen, as the feed wrote it. */
    value: text('value').notNull(),
    count: integer('count').notNull().default(1),
    /** Up to 5 distinct source references (listing refs, feed names) to show staff what it is. */
    examples: jsonb('examples').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Best fuzzy candidate below the accept threshold, as a hint for staff. Never applied. */
    candidateId: uuid('candidate_id'),
    candidateScore: real('candidate_score'),
    status: text('status').notNull().default('OPEN'),
    mappedToId: uuid('mapped_to_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    unique('taxonomy_unmatched_value_uq').on(t.kind, t.valueKey),
    index('taxonomy_unmatched_queue_idx').on(t.status, t.kind, t.count.desc(), t.id),
    check('taxonomy_unmatched_kind_ck', sql`${t.kind} in ('location','propertyType','feature')`),
    check('taxonomy_unmatched_status_ck', sql`${t.status} in ('OPEN','MAPPED','IGNORED')`),
  ],
);
