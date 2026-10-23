/**
 * Tables owned by the developments module (PATTERNS §2, PLAN §6 New developments, §3 #21). Only
 * `packages/core/src/modules/developments` imports this file (`pnpm check:boundaries`). Register each table in
 * `../tenancy/registry.ts`, then run `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * Sharing (S4-01): a development belongs to the agency that maintains it (`agency_id`: the developer, or the
 * agency Inmolink data ops keeps it under). `developments` is NETWORK_READ — other verified agencies read a
 * development that is not deleted, of a listed owner, and either OPEN or PRIVATE_NETWORK with a
 * `development_access` row naming them. Phases, units, translations and shared documents are readable wherever
 * their development is; unit price history and price lists stay with the owner. Every child row carries the
 * development's own `agency_id`, enforced by a composite foreign key to `developments (id, agency_id)`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';
import { translationOriginEnum } from './properties';
import { locations, propertyTypes } from './taxonomy';

export const developmentStatusEnum = pgEnum('development_status', [
  'OFF_PLAN',
  'UNDER_CONSTRUCTION',
  'KEY_READY',
  'SOLD_OUT',
]);
/** OPEN: every verified agency · PRIVATE_NETWORK: only the agencies in `development_access` (PLAN §6). */
export const developmentAccessEnum = pgEnum('development_access_kind', ['OPEN', 'PRIVATE_NETWORK']);
/** Who keeps the data fresh (PLAN §3 #21: freshness SLA 24 h). */
export const developmentManagerEnum = pgEnum('development_manager', ['DEVELOPER', 'DATA_OPS']);
export const unitStatusEnum = pgEnum('unit_status', ['AVAILABLE', 'RESERVED', 'SOLD']);
export const orientationEnum = pgEnum('orientation', ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
/** Who read a price list into units: AI extraction is reviewed by a person before it applies (PLAN §3 AI rules). */
export const priceListExtractorEnum = pgEnum('price_list_extractor', ['AI', 'HUMAN']);
export const developmentDocumentKindEnum = pgEnum('development_document_kind', [
  'BROCHURE',
  'PRICE_LIST',
  'FLOOR_PLAN',
  'SPECIFICATIONS',
  'PAYMENT_PLAN',
  'LEGAL',
  'OTHER',
]);

/** `date_trunc('milliseconds', col, 'UTC')`: the keyset sort key (`keysetOrder`, S2-F1), indexable. */
const keysetTime = (col: unknown) => sql`date_trunc('milliseconds', ${col}, 'UTC')`;

export const developments = pgTable(
  'developments',
  {
    id: uuid('id').primaryKey(),
    /** The developer agency (or the agency data ops keeps the development under). */
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** Human reference; unique within the agency. */
    ref: text('ref').notNull(),
    /** The development's brand name (not translated: "Marbella Heights"). */
    name: text('name').notNull(),
    status: developmentStatusEnum('status').notNull().default('OFF_PLAN'),
    completionDate: date('completion_date'),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    /** The shown point of the development (a building site: not private). */
    lat: numeric('lat', { precision: 9, scale: 6 }),
    lng: numeric('lng', { precision: 9, scale: 6 }),
    /** Commission offered to collaborating agencies: a percentage (basis points) or a fixed amount. */
    commissionBp: integer('commission_bp'),
    commissionFixedCents: bigint('commission_fixed_cents', { mode: 'number' }),
    commissionIncludesVat: boolean('commission_includes_vat').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    managedBy: developmentManagerEnum('managed_by').notNull().default('DEVELOPER'),
    /** When the maintainer last confirmed units and prices (freshness SLA 24 h). */
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    /** Secure by default: a new development reaches no other agency until opened or shared. */
    access: developmentAccessEnum('access').notNull().default('PRIVATE_NETWORK'),
    /** Created by a feed import (S7-F14): the feed keeps its name and location current unless locked (S8-F5). */
    fromFeed: boolean('from_feed').notNull().default(false),
    /** The feed-owned fields the owner locked (`LOCKABLE_DEVELOPMENT_FIELDS`): a feed run leaves them as set. */
    lockedFields: text('locked_fields').array().notNull().default(sql`'{}'::text[]`),
    /** v1 id for migrated developments (S4-04). */
    legacyId: text('legacy_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // target of the children's composite foreign keys (same development, same agency)
    unique('developments_id_agency_uq').on(t.id, t.agencyId),
    uniqueIndex('developments_agency_ref_uq').on(t.agencyId, t.ref),
    // the agency's developments, newest first (keyset)
    index('developments_agency_created_idx').on(t.agencyId, keysetTime(t.createdAt), t.id),
    // FK + network browse by location
    index('developments_location_idx').on(t.locationId),
    // migration: legacy id → development within an agency
    index('developments_agency_legacy_idx').on(t.agencyId, t.legacyId).where(sql`${t.legacyId} is not null`),
    // the purge (S5-F2): soft-deleted developments of every agency, longest deleted first
    index('developments_deleted_idx').on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    check('developments_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'developments_commission_ck',
      sql`(${t.commissionBp} is null or ${t.commissionBp} between 1 and 10000)
        and (${t.commissionFixedCents} is null or ${t.commissionFixedCents} between 1 and 100000000000)
        and not (${t.commissionBp} is not null and ${t.commissionFixedCents} is not null)`,
    ),
    check(
      'developments_coordinates_ck',
      sql`(${t.lat} is null) = (${t.lng} is null)
        and (${t.lat} is null or (${t.lat} between -90 and 90 and ${t.lng} between -180 and 180))`,
    ),
    check('developments_version_ck', sql`${t.version} >= 1`),
    // only the contract's LOCKABLE_DEVELOPMENT_FIELDS (S8-F5); a new feed-owned field widens this check
    check('developments_locked_fields_ck', sql`${t.lockedFields} <@ array['name', 'location']::text[]`),
  ],
);

/**
 * The agencies a PRIVATE_NETWORK development is shared with. The allowed agency reads the rows naming it (the
 * developments policy's `exists` runs under that RLS); only the owner writes them.
 */
export const developmentAccess = pgTable(
  'development_access',
  {
    developmentId: uuid('development_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    allowedAgencyId: uuid('allowed_agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.developmentId, t.allowedAgencyId] }),
    foreignKey({
      name: 'development_access_development_fk',
      columns: [t.developmentId, t.agencyId],
      foreignColumns: [developments.id, developments.agencyId],
    }).onDelete('cascade'),
    // FK + the developments shared with an agency (the network predicate looks up (development, reader))
    index('development_access_allowed_idx').on(t.allowedAgencyId),
    check('development_access_not_owner_ck', sql`${t.allowedAgencyId} <> ${t.agencyId}`),
  ],
);

/** Description, payment terms and SEO text per content locale. */
export const developmentTranslations = pgTable(
  'development_translations',
  {
    developmentId: uuid('development_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** Payment schedule as written by the developer ("10 % on reservation, 30 % during construction, …"). */
    paymentTerms: text('payment_terms'),
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
    primaryKey({ columns: [t.developmentId, t.locale] }),
    foreignKey({
      name: 'development_translations_development_fk',
      columns: [t.developmentId, t.agencyId],
      foreignColumns: [developments.id, developments.agencyId],
    }).onDelete('cascade'),
    check('development_translations_locale_ck', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('development_translations_slug_ck', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/** A construction phase (block, stage) with its own status and completion date. */
export const developmentPhases = pgTable(
  'development_phases',
  {
    id: uuid('id').primaryKey(),
    developmentId: uuid('development_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    name: text('name').notNull(),
    sort: smallint('sort').notNull().default(0),
    status: developmentStatusEnum('status').notNull().default('OFF_PLAN'),
    completionDate: date('completion_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // target of the units' foreign key (a unit's phase is of the same development and agency)
    unique('development_phases_id_development_uq').on(t.id, t.developmentId, t.agencyId),
    foreignKey({
      name: 'development_phases_development_fk',
      columns: [t.developmentId, t.agencyId],
      foreignColumns: [developments.id, developments.agencyId],
    }).onDelete('cascade'),
    // FK + a development's phases in order
    index('development_phases_development_idx').on(t.developmentId, t.sort, t.id),
    check('development_phases_name_ck', sql`char_length(${t.name}) between 1 and 120`),
  ],
);

export const units = pgTable(
  'units',
  {
    id: uuid('id').primaryKey(),
    developmentId: uuid('development_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    phaseId: uuid('phase_id'),
    /** The developer's unit reference ("B-2-3"); unique within the development. */
    ref: text('ref').notNull(),
    propertyTypeId: uuid('property_type_id')
      .notNull()
      .references(() => propertyTypes.id),
    bedrooms: integer('bedrooms'),
    bathrooms: integer('bathrooms'),
    internalM2: numeric('internal_m2', { precision: 10, scale: 2 }),
    terraceM2: numeric('terrace_m2', { precision: 10, scale: 2 }),
    plotM2: numeric('plot_m2', { precision: 10, scale: 2 }),
    /** Floor number: 0 ground, negative below ground. */
    floor: smallint('floor'),
    orientation: orientationEnum('orientation'),
    priceCents: bigint('price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    status: unitStatusEnum('status').notNull().default('AVAILABLE'),
    /** The unit's own commission (S4-02): a percentage or a fixed amount; none → the development's applies. */
    commissionBp: integer('commission_bp'),
    commissionFixedCents: bigint('commission_fixed_cents', { mode: 'number' }),
    commissionIncludesVat: boolean('commission_includes_vat').notNull().default(false),
    /**
     * Created by a feed import (S8-F3): only such units are withdrawn when the feed's price list stops naming them —
     * never the ones the owner added by hand.
     */
    fromFeed: boolean('from_feed').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // target of the price history's composite foreign key
    unique('units_id_agency_uq').on(t.id, t.agencyId),
    foreignKey({
      name: 'units_development_fk',
      columns: [t.developmentId, t.agencyId],
      foreignColumns: [developments.id, developments.agencyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'units_phase_fk',
      columns: [t.phaseId, t.developmentId, t.agencyId],
      foreignColumns: [developmentPhases.id, developmentPhases.developmentId, developmentPhases.agencyId],
    }),
    // FK + a development's unit table by reference; one unit per reference
    uniqueIndex('units_development_ref_uq').on(t.developmentId, t.ref),
    // FK (phase delete checks)
    index('units_phase_idx').on(t.phaseId).where(sql`${t.phaseId} is not null`),
    // FK
    index('units_property_type_idx').on(t.propertyTypeId),
    check('units_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('units_price_ck', sql`${t.priceCents} is null or ${t.priceCents} >= 0`),
    check(
      'units_specs_ck',
      sql`(${t.bedrooms} is null or ${t.bedrooms} between 0 and 1000)
        and (${t.bathrooms} is null or ${t.bathrooms} between 0 and 1000)
        and (${t.internalM2} is null or ${t.internalM2} >= 0)
        and (${t.terraceM2} is null or ${t.terraceM2} >= 0)
        and (${t.plotM2} is null or ${t.plotM2} >= 0)
        and (${t.floor} is null or ${t.floor} between -10 and 300)`,
    ),
    check(
      'units_commission_ck',
      sql`(${t.commissionBp} is null or ${t.commissionBp} between 1 and 10000)
        and (${t.commissionFixedCents} is null or ${t.commissionFixedCents} between 1 and 100000000000)
        and not (${t.commissionBp} is not null and ${t.commissionFixedCents} is not null)`,
    ),
    check('units_version_ck', sql`${t.version} >= 1`),
  ],
);

/**
 * Brochures, plans, price lists and legal files of a development (PDFs in the private bucket). `shared` ones are
 * readable wherever the development is; the others stay with the owner.
 */
export const developmentDocuments = pgTable(
  'development_documents',
  {
    id: uuid('id').primaryKey(),
    developmentId: uuid('development_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    kind: developmentDocumentKindEnum('kind').notNull().default('OTHER'),
    /** Display name as uploaded (sanitized). */
    fileName: text('file_name').notNull(),
    /** Detected from the file's magic bytes: `application/pdf`. */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    storageKey: text('storage_key').notNull(),
    /** Collaborating agencies may read it (brochures, plans); otherwise the owner's only. */
    shared: boolean('shared').notNull().default(false),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // target of the price lists' source document foreign key
    unique('development_documents_id_agency_uq').on(t.id, t.agencyId),
    foreignKey({
      name: 'development_documents_development_fk',
      columns: [t.developmentId, t.agencyId],
      foreignColumns: [developments.id, developments.agencyId],
    }).onDelete('cascade'),
    // FK + a development's documents: where development_id = ? order by created_at, id
    index('development_documents_development_idx').on(t.developmentId, t.createdAt, t.id),
    uniqueIndex('development_documents_key_uq').on(t.storageKey),
    check('development_documents_sha256_ck', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('development_documents_type_ck', sql`${t.contentType} = 'application/pdf'`),
    check('development_documents_size_ck', sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * A version of the development's price list (PLAN §6): read from a source document by AI or a person, reviewed,
 * effective from a date, with the diff against the previous version (S4-02 computes it). The owner's workflow.
 */
export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey(),
    developmentId: uuid('development_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    version: integer('version').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    sourceDocumentId: uuid('source_document_id'),
    extractedBy: priceListExtractorEnum('extracted_by').notNull().default('HUMAN'),
    reviewedByUserId: uuid('reviewed_by_user_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Added / removed / changed units and prices against the previous version (S4-02). */
    diffSummary: jsonb('diff_summary'),
    /** The version as read (S4-02): `[{ ref, priceCents, status? }]`, a snapshot the diff is computed from. */
    entries: jsonb('entries').notNull().default(sql`'[]'::jsonb`),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('price_lists_id_agency_uq').on(t.id, t.agencyId),
    foreignKey({
      name: 'price_lists_development_fk',
      columns: [t.developmentId, t.agencyId],
      foreignColumns: [developments.id, developments.agencyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'price_lists_source_document_fk',
      columns: [t.sourceDocumentId, t.agencyId],
      foreignColumns: [developmentDocuments.id, developmentDocuments.agencyId],
    }),
    // FK + a development's versions, latest first; one row per version
    uniqueIndex('price_lists_development_version_uq').on(t.developmentId, t.version),
    // FK
    index('price_lists_source_document_idx').on(t.sourceDocumentId).where(sql`${t.sourceDocumentId} is not null`),
    check('price_lists_version_ck', sql`${t.version} >= 1`),
    check('price_lists_review_ck', sql`(${t.reviewedByUserId} is null) = (${t.reviewedAt} is null)`),
  ],
);

/** Every price change of a unit: the owner's history, not shared, append-only. */
export const unitPriceHistories = pgTable(
  'unit_price_histories',
  {
    id: uuid('id').primaryKey(),
    unitId: uuid('unit_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    /** The price list version that changed it (null: a manual edit). */
    priceListId: uuid('price_list_id'),
    previousPriceCents: bigint('previous_price_cents', { mode: 'number' }),
    priceCents: bigint('price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull(),
    changedByUserId: uuid('changed_by_user_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'unit_price_histories_unit_fk',
      columns: [t.unitId, t.agencyId],
      foreignColumns: [units.id, units.agencyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'unit_price_histories_price_list_fk',
      columns: [t.priceListId, t.agencyId],
      foreignColumns: [priceLists.id, priceLists.agencyId],
      // S5-F3: price lists go only with their development; NO ACTION failed that delete (units cascade later)
    }).onDelete('cascade'),
    // FK + a unit's price history, newest first
    index('unit_price_histories_unit_idx').on(t.unitId, t.changedAt, t.id),
    // FK
    index('unit_price_histories_price_list_idx').on(t.priceListId).where(sql`${t.priceListId} is not null`),
    check('unit_price_histories_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Every status change of a unit (S4-02): the owner's history, not shared, append-only. */
export const unitStatusHistories = pgTable(
  'unit_status_histories',
  {
    id: uuid('id').primaryKey(),
    unitId: uuid('unit_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    /** The price list version that changed it (null: a manual edit). */
    priceListId: uuid('price_list_id'),
    /** Null on the unit's first row (created). */
    fromStatus: unitStatusEnum('from_status'),
    toStatus: unitStatusEnum('to_status').notNull(),
    changedByUserId: uuid('changed_by_user_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'unit_status_histories_unit_fk',
      columns: [t.unitId, t.agencyId],
      foreignColumns: [units.id, units.agencyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'unit_status_histories_price_list_fk',
      columns: [t.priceListId, t.agencyId],
      foreignColumns: [priceLists.id, priceLists.agencyId],
      // S5-F3: price lists go only with their development; NO ACTION failed that delete (units cascade later)
    }).onDelete('cascade'),
    // FK + a unit's status history, newest first
    index('unit_status_histories_unit_idx').on(t.unitId, t.changedAt, t.id),
    // FK
    index('unit_status_histories_price_list_idx').on(t.priceListId).where(sql`${t.priceListId} is not null`),
  ],
);
