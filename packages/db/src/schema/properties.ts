/**
 * Tables owned by the properties module (PATTERNS §2, PLAN §6 Properties). Only
 * `packages/core/src/modules/properties` imports this file (`pnpm check:boundaries`). Register each table in
 * `../tenancy/registry.ts`, then run `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * Sharing (S3-01): `properties` is NETWORK_READ — other verified agencies read SHARED/PUBLIC, ACTIVE, not
 * deleted rows of a listed owner (PREFERRED scope: only agencies the owner prefers). RLS shares whole rows, so
 * a listing's private fields live in the STRICT `property_privates`. Translations, features and media are
 * readable wherever their listing is; price and status history stays with the owner. Every child row carries
 * the listing's own `agency_id`, enforced by a composite foreign key to `properties (id, agency_id)`: an agency
 * cannot hang rows on another agency's listing.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';
import { agencyMembers } from './identity';
import { features, locations, propertyTypes } from './taxonomy';

/** PRIVATE: own agency only · SHARED: the network of verified agencies · PUBLIC: also websites and portals. */
export const visibilityEnum = pgEnum('visibility', ['PRIVATE', 'SHARED', 'PUBLIC']);
/** Who in the network sees a shared listing (PLAN §3 #57): every verified agency, or preferred ones only. */
export const shareScopeEnum = pgEnum('share_scope', ['ALL', 'PREFERRED']);
export const listingStatusEnum = pgEnum('listing_status', [
  'DRAFT',
  'ACTIVE',
  'UNDER_OFFER',
  'SOLD',
  'RENTED',
  'WITHDRAWN',
]);
export const transactionTypeEnum = pgEnum('transaction_type', ['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM']);
/** EXACT: the pin is the property · APPROX: a shown area, never the address (privacy). */
export const locationPrecisionEnum = pgEnum('location_precision', ['EXACT', 'APPROX']);
/** Who wrote a translation (PLAN §3 AI rules): AI drafts stay marked until a person reviews them. */
export const translationOriginEnum = pgEnum('translation_origin', ['HUMAN', 'AI_DRAFT', 'REVIEWED']);
export const propertyMediaKindEnum = pgEnum('property_media_kind', ['IMAGE', 'FLOOR_PLAN', 'VIDEO', 'DOCUMENT']);
/** What a rent price is per (sale prices have none). */
export const pricePeriodEnum = pgEnum('price_period', ['NIGHT', 'WEEK', 'MONTH']);
/** CEE label letters (PLAN §13): consumption and emissions are rated separately; EXEMPT / PENDING per Spanish rules. */
export const ceeRatingEnum = pgEnum('cee_rating', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'EXEMPT', 'PENDING']);

/** `date_trunc('milliseconds', col, 'UTC')`: the keyset sort key (`keysetOrder`, S2-F1), indexable. */
const keysetTime = (col: unknown) => sql`date_trunc('milliseconds', ${col}, 'UTC')`;

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The member responsible for the listing (agents edit their own, S3-02); a member of the owner agency. */
    ownerUserId: uuid('owner_user_id').notNull(),
    /** Human reference shown on websites and in the dashboard; unique within the agency. */
    ref: text('ref').notNull(),
    /** Where the listing came from: `MANUAL`, a feed format (`KYERO`, …) or `LEGACY`. */
    source: text('source').notNull().default('MANUAL'),
    /** The listing's id in its source feed (re-import dedupe). */
    externalRef: text('external_ref'),
    /** v1 id for migrated listings (PLAN §14); `legacy_id_maps` keeps the global map. */
    legacyId: text('legacy_id'),
    status: listingStatusEnum('status').notNull().default('DRAFT'),
    visibility: visibilityEnum('visibility').notNull().default('PRIVATE'),
    shareScope: shareScopeEnum('share_scope').notNull().default('ALL'),
    transactionType: transactionTypeEnum('transaction_type').notNull().default('SALE'),
    priceCents: bigint('price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Rentals only: what the price is per. */
    pricePeriod: pricePeriodEnum('price_period'),
    priceOnRequest: boolean('price_on_request').notNull().default(false),
    /** Total commission in basis points of the sale price (agency default 500 = 5 %, PLAN §3 #7). */
    commissionBp: integer('commission_bp'),
    /** A fixed commission instead of a percentage. */
    commissionFixedCents: bigint('commission_fixed_cents', { mode: 'number' }),
    /** The collaborating agent's share of the commission (agency default 5000 = 50/50). */
    splitBp: integer('split_bp'),
    commissionIncludesVat: boolean('commission_includes_vat').notNull().default(false),
    builtM2: numeric('built_m2', { precision: 10, scale: 2 }),
    plotM2: numeric('plot_m2', { precision: 10, scale: 2 }),
    terraceM2: numeric('terrace_m2', { precision: 10, scale: 2 }),
    bedrooms: integer('bedrooms'),
    bathrooms: integer('bathrooms'),
    yearBuilt: integer('year_built'),
    /** CEE energy consumption rating; required before PUBLIC (S3-02). */
    energyRating: ceeRatingEnum('energy_rating'),
    /** CEE emissions rating (portal exports carry both). */
    energyEmissionsRating: ceeRatingEnum('energy_emissions_rating'),
    /**
     * The point shown to the network, websites and portals: the property itself when `location_precision` is
     * EXACT, otherwise an offset point (S3-02 derives it). The exact pin lives in `property_privates`.
     */
    lat: numeric('lat', { precision: 9, scale: 6 }),
    lng: numeric('lng', { precision: 9, scale: 6 }),
    locationPrecision: locationPrecisionEnum('location_precision').notNull().default('APPROX'),
    propertyTypeId: uuid('property_type_id')
      .notNull()
      .references(() => propertyTypes.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    /** New-build development and unit (later sprints add their tables and foreign keys). */
    developmentId: uuid('development_id'),
    unitId: uuid('unit_id'),
    /** Cross-agency duplicate cluster (later sprint) and whether this row represents it. */
    duplicateClusterId: uuid('duplicate_cluster_id'),
    isCanonical: boolean('is_canonical').notNull().default(true),
    /** 0–100 listing quality (photos, description, translations, location precision, freshness). */
    qualityScore: integer('quality_score'),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }),
    /** Fields a feed re-import must not overwrite (S6). */
    lockedFields: text('locked_fields').array().notNull().default(sql`'{}'::text[]`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete: restorable for 30 days (S3-02). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // target of the children's composite foreign keys (same listing, same agency)
    unique('properties_id_agency_uq').on(t.id, t.agencyId),
    // the agency's own references (refs are per agency: a global unique would tell one agency another's refs)
    uniqueIndex('properties_agency_ref_uq').on(t.agencyId, t.ref),
    // the agency's listings, newest first (keyset `keysetOrder`, S2-F1): where agency_id = ? order by … desc
    index('properties_agency_created_idx').on(t.agencyId, keysetTime(t.createdAt), t.id),
    // FK to the owner's membership + an agent's own listings: where agency_id = ? and owner_user_id = ?
    index('properties_agency_owner_idx').on(t.agencyId, t.ownerUserId),
    foreignKey({
      name: 'properties_owner_member_fk',
      columns: [t.agencyId, t.ownerUserId],
      foreignColumns: [agencyMembers.agencyId, agencyMembers.userId],
    }),
    // feed re-import dedupe: one listing per (agency, source, external ref)
    uniqueIndex('properties_source_ref_uq')
      .on(t.agencyId, t.source, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
    // migration: legacy id → listing within an agency
    index('properties_agency_legacy_idx').on(t.agencyId, t.legacyId).where(sql`${t.legacyId} is not null`),
    // FK (location delete/merge checks) + network fallback by location and type: uuid `=` is leakproof, so it
    // is an index condition under RLS — enum (visibility, status) conditions are not, hence not indexed (S2-F1)
    index('properties_location_type_idx').on(t.locationId, t.propertyTypeId, t.priceCents),
    // FK
    index('properties_property_type_idx').on(t.propertyTypeId),
    // duplicate clusters (later sprint)
    index('properties_duplicate_cluster_idx').on(t.duplicateClusterId).where(sql`${t.duplicateClusterId} is not null`),
    check('properties_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('properties_price_ck', sql`${t.priceCents} is null or ${t.priceCents} >= 0`),
    check('properties_price_period_ck', sql`${t.pricePeriod} is null or ${t.transactionType} <> 'SALE'`),
    check(
      'properties_commission_ck',
      sql`(${t.commissionBp} is null or ${t.commissionBp} between 1 and 10000)
        and (${t.commissionFixedCents} is null or ${t.commissionFixedCents} between 1 and 100000000000)
        and not (${t.commissionBp} is not null and ${t.commissionFixedCents} is not null)`,
    ),
    check('properties_split_ck', sql`${t.splitBp} is null or ${t.splitBp} between 0 and 10000`),
    check(
      'properties_specs_ck',
      sql`(${t.bedrooms} is null or ${t.bedrooms} between 0 and 1000)
        and (${t.bathrooms} is null or ${t.bathrooms} between 0 and 1000)
        and (${t.yearBuilt} is null or ${t.yearBuilt} between 1000 and 3000)
        and (${t.builtM2} is null or ${t.builtM2} >= 0)
        and (${t.plotM2} is null or ${t.plotM2} >= 0)
        and (${t.terraceM2} is null or ${t.terraceM2} >= 0)`,
    ),
    check(
      'properties_coordinates_ck',
      sql`(${t.lat} is null) = (${t.lng} is null)
        and (${t.lat} is null or (${t.lat} between -90 and 90 and ${t.lng} between -180 and 180))`,
    ),
    check('properties_quality_ck', sql`${t.qualityScore} is null or ${t.qualityScore} between 0 and 100`),
    check('properties_version_ck', sql`${t.version} >= 1`),
  ],
);

/** A listing's private fields (STRICT): never readable by another agency, never sent to a client. */
export const propertyPrivates = pgTable(
  'property_privates',
  {
    propertyId: uuid('property_id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    /** Referencia catastral (PLAN §6: private). */
    cadastralRef: text('cadastral_ref'),
    /** The seller (contacts arrive in S4; foreign key then). */
    sellerContactId: uuid('seller_contact_id'),
    internalNotes: text('internal_notes'),
    /** Where the keys are, viewing instructions: internal. */
    keysInfo: text('keys_info'),
    /** The exact pin (the address): never shared; `properties.lat/lng` is the shown point. */
    exactLat: numeric('exact_lat', { precision: 9, scale: 6 }),
    exactLng: numeric('exact_lng', { precision: 9, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'property_privates_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    check(
      'property_privates_coordinates_ck',
      sql`(${t.exactLat} is null) = (${t.exactLng} is null)
        and (${t.exactLat} is null or (${t.exactLat} between -90 and 90 and ${t.exactLng} between -180 and 180))`,
    ),
  ],
);

/** Title, description and SEO text per content locale. */
export const propertyTranslations = pgTable(
  'property_translations',
  {
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    slug: text('slug').notNull(),
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    origin: translationOriginEnum('origin').notNull().default('HUMAN'),
    /** A person fixed this text: machine translation never overwrites it. */
    locked: boolean('locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.propertyId, t.locale] }),
    foreignKey({
      name: 'property_translations_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    check('property_translations_locale_ck', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('property_translations_slug_ck', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/** The listing's features (pool, sea view, …) from the taxonomy (S2-02). */
export const propertyFeatures = pgTable(
  'property_features',
  {
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    featureId: uuid('feature_id')
      .notNull()
      .references(() => features.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.propertyId, t.featureId] }),
    foreignKey({
      name: 'property_features_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + "listings with this feature"
    index('property_features_feature_idx').on(t.featureId),
  ],
);

/** Every price change (S3-02 writes one per change): the owner's history, not shared, append-only. */
export const propertyPriceHistories = pgTable(
  'property_price_histories',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    previousPriceCents: bigint('previous_price_cents', { mode: 'number' }),
    priceCents: bigint('price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull(),
    changedByUserId: uuid('changed_by_user_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'property_price_histories_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + a listing's price history, newest first
    index('property_price_histories_property_idx').on(t.propertyId, t.changedAt, t.id),
    check('property_price_histories_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Every status change (S3-02 writes one per change): the owner's history, not shared, append-only. */
export const propertyStatusHistories = pgTable(
  'property_status_histories',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    fromStatus: listingStatusEnum('from_status'),
    toStatus: listingStatusEnum('to_status').notNull(),
    changedByUserId: uuid('changed_by_user_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'property_status_histories_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + a listing's status history, newest first
    index('property_status_histories_property_idx').on(t.propertyId, t.changedAt, t.id),
  ],
);

/**
 * The listing's media in order: a reference to a content-addressed `media_objects` row (S3-03 adds that table
 * and the foreign key; variants are derived from its sha256, no variant table).
 */
export const propertyMedia = pgTable(
  'property_media',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    mediaObjectId: uuid('media_object_id').notNull(),
    kind: propertyMediaKindEnum('kind').notNull().default('IMAGE'),
    position: integer('position').notNull(),
    isCover: boolean('is_cover').notNull().default(false),
    altText: text('alt_text'),
    /** Room shown (`kitchen`, `bedroom`, …): AI-tagged or set by the agent. */
    roomType: text('room_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'property_media_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // FK + a listing's media in order
    index('property_media_property_idx').on(t.propertyId, t.position),
    // one cover per listing
    uniqueIndex('property_media_cover_uq').on(t.propertyId).where(sql`${t.isCover}`),
    // reference counting and deletion of a media object (S3-03)
    index('property_media_object_idx').on(t.mediaObjectId),
    check('property_media_position_ck', sql`${t.position} >= 0`),
  ],
);
