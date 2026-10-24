/**
 * Tables owned by the properties module (PATTERNS §2, PLAN §6 Properties). Only
 * `packages/core/src/modules/properties` imports this file (`pnpm check:boundaries`). Register each table in
 * `../tenancy/registry.ts`, then run `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * Sharing (S3-01): `properties` is NETWORK_READ — other verified agencies read SHARED/PUBLIC, ACTIVE, not
 * deleted rows of a listed owner (PREFERRED scope: only agencies the owner prefers). RLS shares whole rows, so
 * a listing's private fields live in the STRICT `property_privates`. Translations, features and media are
 * readable wherever their listing is (media rows belong to the media module, `./media.ts`, S3-03); price and
 * status history stays with the owner. Every child row carries the listing's own `agency_id`, enforced by a
 * composite foreign key to `properties (id, agency_id)`: an agency cannot hang rows on another agency's listing.
 */

import { type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
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
/**
 * `status_code` per status (S3 review): the list's status filter compares this smallint — `int2eq` is leakproof,
 * so it is an index condition under RLS, where the enum's `=` is not. A status added to the enum needs a code
 * here and a migration; until then its inserts fail on `not null` instead of being filtered wrongly.
 */
export const LISTING_STATUS_CODES = {
  DRAFT: 1,
  ACTIVE: 2,
  UNDER_OFFER: 3,
  SOLD: 4,
  RENTED: 5,
  WITHDRAWN: 6,
} as const satisfies Record<(typeof listingStatusEnum.enumValues)[number], number>;
const statusCode = (): SQL =>
  sql.raw(
    `case status ${Object.entries(LISTING_STATUS_CODES)
      .map(([k, v]) => `when '${k}' then ${v}`)
      .join(' ')} end`,
  );
export const transactionTypeEnum = pgEnum('transaction_type', ['SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM']);
/** EXACT: the pin is the property · APPROX: a shown area, never the address (privacy). */
export const locationPrecisionEnum = pgEnum('location_precision', ['EXACT', 'APPROX']);
/** Who wrote a translation (PLAN §3 AI rules): AI drafts stay marked until a person reviews them. */
export const translationOriginEnum = pgEnum('translation_origin', ['HUMAN', 'AI_DRAFT', 'REVIEWED']);
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
    /**
     * `upper(ref)`, stored (S3 review): the list's reference prefix is a byte range on it in the C collation
     * (`ref_key collate "C" >= P and < succ(P)`, leakproof text comparisons) instead of `upper(ref) like`,
     * which RLS keeps out of index conditions.
     */
    refKey: text('ref_key')
      .notNull()
      .generatedAlwaysAs((): SQL => sql`upper(ref)`),
    /** Where the listing came from: `MANUAL`, a feed format (`KYERO`, …) or `LEGACY`. */
    source: text('source').notNull().default('MANUAL'),
    /** v1 id for migrated listings (PLAN §14); `legacy_id_maps` keeps the global map. */
    legacyId: text('legacy_id'),
    status: listingStatusEnum('status').notNull().default('DRAFT'),
    /** `LISTING_STATUS_CODES[status]`, stored: the indexable form of the list's status filter. */
    statusCode: smallint('status_code').notNull().generatedAlwaysAs(statusCode),
    visibility: visibilityEnum('visibility').notNull().default('PRIVATE'),
    shareScope: shareScopeEnum('share_scope').notNull().default('ALL'),
    transactionType: transactionTypeEnum('transaction_type').notNull().default('SALE'),
    priceCents: bigint('price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Rentals only: what the price is per. */
    pricePeriod: pricePeriodEnum('price_period'),
    priceOnRequest: boolean('price_on_request').notNull().default(false),
    /** The end of a price range (new developments: `priceCents` is the low end); null for a single price (S7-F14). */
    priceToCents: bigint('price_to_cents', { mode: 'number' }),
    /** Running costs the listing shows (S7-F14): the community fee per month, IBI and the refuse tax per year. */
    communityFeeMonthCents: bigint('community_fee_month_cents', { mode: 'number' }),
    ibiYearCents: bigint('ibi_year_cents', { mode: 'number' }),
    garbageTaxYearCents: bigint('garbage_tax_year_cents', { mode: 'number' }),
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
    /**
     * The location's country, region and city (itself at its own level), written with `location_id` (S3-F6): the
     * list filters a location's whole subtree by one `=` on its level's column — leakproof, so an index condition
     * under RLS — without reading taxonomy tables. An area filter is `location_id`.
     */
    countryId: uuid('country_id'),
    regionId: uuid('region_id'),
    cityId: uuid('city_id'),
    /** New-build development and unit (later sprints add their tables and foreign keys). */
    developmentId: uuid('development_id'),
    unitId: uuid('unit_id'),
    /** Cross-agency duplicate cluster (later sprint) and whether this row represents it. */
    duplicateClusterId: uuid('duplicate_cluster_id'),
    isCanonical: boolean('is_canonical').notNull().default(true),
    /**
     * Freshness (S3-08): when an agent last confirmed the listing is still on the market (create, the confirm
     * button, going ACTIVE again). 90 days later the agent is prompted (`confirm_prompted_at`); 120 days later
     * the listing leaves the network (`network_hidden_at`, in the RLS network predicate) until confirmed again.
     */
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    confirmPromptedAt: timestamp('confirm_prompted_at', { withTimezone: true }),
    networkHiddenAt: timestamp('network_hidden_at', { withTimezone: true }),
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
    // the list filtered by a region / city / area subtree (S3-F6), newest first; other orders sort the matches
    index('properties_agency_region_idx').on(t.agencyId, t.regionId, keysetTime(t.createdAt), t.id),
    index('properties_agency_city_idx').on(t.agencyId, t.cityId, keysetTime(t.createdAt), t.id),
    index('properties_agency_location_idx').on(t.agencyId, t.locationId, keysetTime(t.createdAt), t.id),
    // the list filtered by status (S3 review), newest first; other orders sort the matches (a rare status is few)
    index('properties_agency_status_idx')
      .on(t.agencyId, t.statusCode, keysetTime(t.createdAt), t.id)
      .where(sql`${t.deletedAt} is null`),
    // the list filtered by a country subtree (S3 review: depth-1 filter of `country_id`), newest first
    index('properties_agency_country_idx').on(t.agencyId, t.countryId, keysetTime(t.createdAt), t.id),
    // the list's reference prefix (S3 review): `ref_key collate "C" >= P and < succ(P)` within the agency
    index('properties_agency_ref_key_idx').on(t.agencyId, sql`(${t.refKey} collate "C")`),
    // FK to the owner's membership + an agent's own listings (`mine`), newest first: keyset like the agency list
    index('properties_agency_owner_idx').on(t.agencyId, t.ownerUserId, keysetTime(t.createdAt), t.id),
    // the dashboard list sorted by last change (S3-07 `sort=updated`), keyset like the created order
    index('properties_agency_updated_idx').on(t.agencyId, keysetTime(t.updatedAt), t.id),
    // the dashboard list sorted by price (S3-07), listings without a price last: `sort=price_asc` walks the first
    // forwards; `sort=price_desc` needs its own (a backward scan of the first puts them first)
    index('properties_agency_price_idx').on(t.agencyId, t.priceCents, t.id),
    index('properties_agency_price_desc_idx').on(t.agencyId, t.priceCents.desc().nullsLast(), t.id.desc()),
    // the restorable (soft-deleted) listings of an agency, newest first: few rows, so a partial index
    index('properties_agency_deleted_idx')
      .on(t.agencyId, keysetTime(t.createdAt), t.id)
      .where(sql`${t.deletedAt} is not null`),
    // the purge (S5-F2): soft-deleted listings of every agency, longest deleted first (built CONCURRENTLY)
    index('properties_deleted_idx').on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    foreignKey({
      name: 'properties_owner_member_fk',
      columns: [t.agencyId, t.ownerUserId],
      foreignColumns: [agencyMembers.agencyId, agencyMembers.userId],
    }),
    // migration: legacy id → listing within an agency
    index('properties_agency_legacy_idx').on(t.agencyId, t.legacyId).where(sql`${t.legacyId} is not null`),
    // FK (location delete/merge checks) + network fallback by location and type: uuid `=` is leakproof, so it
    // is an index condition under RLS — enum (visibility, status) conditions are not, hence not indexed (S2-F1)
    index('properties_location_type_idx').on(t.locationId, t.propertyTypeId, t.priceCents),
    // FK
    index('properties_property_type_idx').on(t.propertyTypeId),
    // freshness sweeps (S3-08, `properties.sweepFreshness`): active listings not prompted yet / still on the
    // network, the longest unconfirmed first — each sweep reads only the due rows
    index('properties_confirm_prompt_idx')
      .on(t.lastConfirmedAt)
      .where(sql`${t.status} = 'ACTIVE' and ${t.deletedAt} is null and ${t.confirmPromptedAt} is null`),
    index('properties_network_hide_idx')
      .on(t.lastConfirmedAt)
      .where(sql`${t.status} = 'ACTIVE' and ${t.deletedAt} is null and ${t.networkHiddenAt} is null`),
    // give-to-get (S5-05, PLAN §3 #5): an agency's listings on the network now — counted up to the threshold on
    // every network search, so it reads only those rows, not the agency's PRIVATE or inactive ones
    index('properties_agency_network_idx')
      .on(t.agencyId)
      .where(
        sql`${t.visibility} <> 'PRIVATE' and ${t.status} = 'ACTIVE' and ${t.deletedAt} is null and ${t.networkHiddenAt} is null`,
      ),
    // portal selection (S9-01): an agency's live PUBLIC listings in id order, keyset-paged per connection:
    // where agency_id = ? and status = 'ACTIVE' and visibility = 'PUBLIC' and deleted_at is null and id > ? order by id
    index('properties_agency_export_idx')
      .on(t.agencyId, t.id)
      .where(sql`${t.status} = 'ACTIVE' and ${t.visibility} = 'PUBLIC' and ${t.deletedAt} is null`),
    // duplicate clusters (later sprint)
    index('properties_duplicate_cluster_idx').on(t.duplicateClusterId).where(sql`${t.duplicateClusterId} is not null`),
    check('properties_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('properties_price_ck', sql`${t.priceCents} is null or ${t.priceCents} >= 0`),
    check(
      'properties_costs_ck',
      sql`(${t.priceToCents} is null or ${t.priceToCents} >= 0)
        and (${t.communityFeeMonthCents} is null or ${t.communityFeeMonthCents} >= 0)
        and (${t.ibiYearCents} is null or ${t.ibiYearCents} >= 0)
        and (${t.garbageTaxYearCents} is null or ${t.garbageTaxYearCents} >= 0)`,
    ),
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
    /**
     * The seller: a crm contact of this agency (S10-07: a converted seller prospect sets it). No FK — crm's table; a
     * contact merge re-points it (`crm.contact.merged` → `properties.repointSellerContact`). Never readable by another
     * agency (STRICT), never in a DTO, a read model or a client view.
     */
    sellerContactId: uuid('seller_contact_id'),
    internalNotes: text('internal_notes'),
    /** Where the keys are, viewing instructions: internal. */
    keysInfo: text('keys_info'),
    /** The exact pin (the address): never shared; `properties.lat/lng` is the shown point. */
    exactLat: numeric('exact_lat', { precision: 9, scale: 6 }),
    exactLng: numeric('exact_lng', { precision: 9, scale: 6 }),
    /**
     * The listing's id in its source feed and that feed (re-import dedupe, S6): the owner's portal reference, so
     * here rather than on the network-shared `properties` row (S4-F1). Both set or neither.
     */
    externalSource: text('external_source'),
    externalRef: text('external_ref'),
    /**
     * 0–100 listing quality (photos, description, translations, location precision, freshness): owner only, its
     * freshness part would tell other agencies the listing went unconfirmed (S4-F1).
     */
    qualityScore: integer('quality_score'),
    /**
     * Feed import state (S6-02, owner only). `import_hash`: SHA-256 of the listing as last imported — the feed's
     * values with their resolved taxonomy ids — so an unchanged item is skipped without touching the row;
     * `import_images_hash` the same for its image URLs. `import_connection_id` is the feed connection that last
     * delivered it (no foreign key: imports owns connections; a deleted connection's listings simply stay).
     * `import_missed_runs` counts the connection's successful runs in a row without it (at N it is WITHDRAWN,
     * `import_withdrawn_at`); `import_held` names the taxonomy kinds that hold it as DRAFT, until staff map them.
     */
    importHash: char('import_hash', { length: 64 }),
    importImagesHash: char('import_images_hash', { length: 64 }),
    importConnectionId: uuid('import_connection_id'),
    importMissedRuns: smallint('import_missed_runs').notNull().default(0),
    importWithdrawnAt: timestamp('import_withdrawn_at', { withTimezone: true }),
    importHeld: text('import_held').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'property_privates_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // feed re-import dedupe: one listing per (agency, source, external ref)
    uniqueIndex('property_privates_source_ref_uq')
      .on(t.agencyId, t.externalSource, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
    check('property_privates_external_ck', sql`(${t.externalSource} is null) = (${t.externalRef} is null)`),
    // the end of a feed run (S6-02): the connection's listings, to find the ones missing from this run (built CONCURRENTLY)
    index('property_privates_import_connection_idx')
      .on(t.agencyId, t.importConnectionId, t.externalRef)
      .where(sql`${t.importConnectionId} is not null`),
    // a contact merge (S10-07): where agency_id = ? and seller_contact_id = ? (built CONCURRENTLY)
    index('property_privates_seller_idx')
      .on(t.agencyId, t.sellerContactId)
      .where(sql`${t.sellerContactId} is not null`),
    check('property_privates_quality_ck', sql`${t.qualityScore} is null or ${t.qualityScore} between 0 and 100`),
    check('property_privates_import_missed_ck', sql`${t.importMissedRuns} >= 0`),
    check(
      'property_privates_import_hash_ck',
      sql`(${t.importHash} is null or ${t.importHash} ~ '^[0-9a-f]{64}$')
        and (${t.importImagesHash} is null or ${t.importImagesHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'property_privates_coordinates_ck',
      sql`(${t.exactLat} is null) = (${t.exactLng} is null)
        and (${t.exactLat} is null or (${t.exactLat} between -90 and 90 and ${t.exactLng} between -180 and 180))`,
    ),
  ],
);

/**
 * The feed references a run saw (S6-02): every item of the feed — imported, unchanged or failed with a reference —
 * so the end of a successful run finds the connection's listings missing from it. Written per batch in the batch
 * transaction; deleted when the run ends (`imports.pruneRuns` removes what a crashed run left). S7-F3: UNLOGGED like the
 * staging table (set in 0098) and vacuumed often (about 2M inserts and deletes an hour at 5,000 agencies). A crash or
 * a failover empties it: the run's logged count (`feed_runs.items_seen`) catches that before the anti-join, and the
 * run starts over.
 */
export const propertyImportSeen = pgTable(
  'property_import_seen',
  {
    /** No foreign key (S7-F3): rows live for one run, like the staging table's; RLS scopes them. */
    agencyId: uuid('agency_id').notNull(),
    /** The feed run (no foreign key: imports owns runs). */
    runId: uuid('run_id').notNull(),
    externalRef: text('external_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the missing-listing anti-join of a run, and its delete
    primaryKey({ columns: [t.runId, t.externalRef] }),
    // the prune of rows a crashed run left, oldest first
    index('property_import_seen_created_idx').on(t.createdAt),
    check('property_import_seen_ref_ck', sql`char_length(${t.externalRef}) between 1 and 200`),
  ],
);

/**
 * Feed import staging (S6-02, PATTERNS §13): a batch's items, COPY'd in, matched and MERGEd into `properties`, then
 * deleted — all in the batch transaction, so no row is ever visible to another transaction. UNLOGGED (set in 0080:
 * nothing to recover after a crash) and RLS like any tenant table (app roles have no TEMPORARY, S0-04). `batch_id`
 * keys one batch; the lookup columns (`existing_id` …) are filled by the match step.
 */
export const propertyImportStaging = pgTable(
  'property_import_staging',
  {
    batchId: uuid('batch_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    ref: text('ref').notNull(),
    hash: char('hash', { length: 64 }).notNull(),
    imagesHash: char('images_hash', { length: 64 }),
    held: text('held').array().notNull(),
    status: listingStatusEnum('status').notNull(),
    transactionType: transactionTypeEnum('transaction_type').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull(),
    pricePeriod: pricePeriodEnum('price_period'),
    priceOnRequest: boolean('price_on_request').notNull(),
    priceToCents: bigint('price_to_cents', { mode: 'number' }),
    communityFeeMonthCents: bigint('community_fee_month_cents', { mode: 'number' }),
    ibiYearCents: bigint('ibi_year_cents', { mode: 'number' }),
    garbageTaxYearCents: bigint('garbage_tax_year_cents', { mode: 'number' }),
    builtM2: numeric('built_m2', { precision: 10, scale: 2 }),
    plotM2: numeric('plot_m2', { precision: 10, scale: 2 }),
    terraceM2: numeric('terrace_m2', { precision: 10, scale: 2 }),
    bedrooms: integer('bedrooms'),
    bathrooms: integer('bathrooms'),
    yearBuilt: integer('year_built'),
    energyRating: ceeRatingEnum('energy_rating'),
    energyEmissionsRating: ceeRatingEnum('energy_emissions_rating'),
    lat: numeric('lat', { precision: 9, scale: 6 }),
    lng: numeric('lng', { precision: 9, scale: 6 }),
    exactLat: numeric('exact_lat', { precision: 9, scale: 6 }),
    exactLng: numeric('exact_lng', { precision: 9, scale: 6 }),
    locationPrecision: locationPrecisionEnum('location_precision').notNull(),
    propertyTypeId: uuid('property_type_id'),
    locationId: uuid('location_id'),
    countryId: uuid('country_id'),
    regionId: uuid('region_id'),
    cityId: uuid('city_id'),
    featureIds: uuid('feature_ids').array().notNull(),
    translations: jsonb('translations').notNull(),
    newId: uuid('new_id').notNull(),
    newRef: text('new_ref').notNull(),
    existingId: uuid('existing_id'),
    live: boolean('live').notNull().default(false),
    oldHash: char('old_hash', { length: 64 }),
    oldImagesHash: char('old_images_hash', { length: 64 }),
    oldMissed: smallint('old_missed').notNull().default(0),
    oldWithdrawn: boolean('old_withdrawn').notNull().default(false),
    oldConn: uuid('old_conn'),
  },
  (t) => [
    // one batch's rows by feed reference (every statement of the batch filters on batch_id)
    primaryKey({ columns: [t.batchId, t.ref] }),
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

/** An agency's own labels on its listings (S3-07: bulk "add tag", list filter); internal, never shared. */
export const propertyTags = pgTable(
  'property_tags',
  {
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    /** Lower-case, trimmed (`ListingTag`). */
    tag: text('tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.propertyId, t.tag] }),
    foreignKey({
      name: 'property_tags_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // the list filter `tag=` (the agency's listings with this tag)
    index('property_tags_agency_tag_idx').on(t.agencyId, t.tag, t.propertyId),
    check('property_tags_tag_ck', sql`char_length(${t.tag}) between 1 and 40 and ${t.tag} = lower(btrim(${t.tag}))`),
  ],
);

/** A member's saved listing list: filters, sort and columns (S3-07). Private to the member. */
export const listingViews = pgTable(
  'listing_views',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    /** The list query (`ListingViewQuery`): filters and sort, validated by the contract on write and read. */
    query: jsonb('query').notNull(),
    /** Shown columns, in order (`ListingColumn`). */
    columns: text('columns').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'listing_views_member_fk',
      columns: [t.agencyId, t.userId],
      foreignColumns: [agencyMembers.agencyId, agencyMembers.userId],
    }).onDelete('cascade'),
    // FK + a member's views by name (one name once)
    uniqueIndex('listing_views_member_name_uq').on(t.agencyId, t.userId, t.name),
    check('listing_views_name_ck', sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/** A member's bookmark folder (S3-09): saved listings with notes, private to the member; one click to a selection. */
export const bookmarkFolders = pgTable(
  'bookmark_folders',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'bookmark_folders_member_fk',
      columns: [t.agencyId, t.userId],
      foreignColumns: [agencyMembers.agencyId, agencyMembers.userId],
    }).onDelete('cascade'),
    // FK + a member's folders by name (one name once)
    uniqueIndex('bookmark_folders_member_name_uq').on(t.agencyId, t.userId, t.name),
    // target of the bookmarks' composite foreign key (a bookmark sits in a folder of the same member)
    unique('bookmark_folders_id_member_uq').on(t.id, t.agencyId, t.userId),
    check('bookmark_folders_name_ck', sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/**
 * A saved listing in a member's folder (S3-09). `property_id` has no foreign key: the listing may be another
 * agency's, and a bookmark outlives the listing leaving the caller's view (sold, unshared, deleted) — it then
 * reads as unavailable instead of disappearing.
 */
export const listingBookmarks = pgTable(
  'listing_bookmarks',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    userId: uuid('user_id').notNull(),
    folderId: uuid('folder_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'listing_bookmarks_folder_fk',
      columns: [t.folderId, t.agencyId, t.userId],
      foreignColumns: [bookmarkFolders.id, bookmarkFolders.agencyId, bookmarkFolders.userId],
    }).onDelete('cascade'),
    // FK + a folder's bookmarks, newest first (keyset `keysetOrder`); a listing once per folder
    index('listing_bookmarks_folder_created_idx').on(t.agencyId, t.folderId, keysetTime(t.createdAt), t.id),
    uniqueIndex('listing_bookmarks_folder_property_uq').on(t.agencyId, t.folderId, t.propertyId),
    // the caller's bookmarks of one listing (the editor's bookmark button)
    index('listing_bookmarks_member_property_idx').on(t.agencyId, t.userId, t.propertyId),
    check('listing_bookmarks_note_ck', sql`char_length(${t.note}) <= 1000`),
  ],
);

export const listingBulkActionTypeEnum = pgEnum('listing_bulk_action_type', [
  'STATUS',
  'VISIBILITY',
  'SHARE_SCOPE',
  'PRICE_CHANGE',
  'ASSIGN',
  'ADD_TAG',
]);
export const listingBulkStateEnum = pgEnum('listing_bulk_state', ['QUEUED', 'RUNNING', 'DONE', 'FAILED']);

/**
 * A bulk change of listings (S3-07), run by the worker in chunks (`properties.runBulkAction`). The counters
 * and `processed` move in the transaction of each chunk, so a retried job resumes where it stopped and never
 * applies a chunk twice.
 */
export const listingBulkActions = pgTable(
  'listing_bulk_actions',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The member who asked; the job acts as them (role re-read per chunk). */
    createdByUserId: uuid('created_by_user_id').notNull(),
    type: listingBulkActionTypeEnum('type').notNull(),
    /** The action's parameters (`ListingBulkAction` without `type`), validated by the contract. */
    params: jsonb('params').notNull(),
    /** The listings, in the order they are processed (≤ `LISTING_BULK_MAX`). */
    listingIds: uuid('listing_ids').array().notNull(),
    state: listingBulkStateEnum('state').notNull().default('QUEUED'),
    total: integer('total').notNull(),
    processed: integer('processed').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** The first failures (listing id + error code), capped (`LISTING_BULK_FAILURES_KEPT`). */
    failures: jsonb('failures').notNull().default(sql`'[]'::jsonb`),
    /** Why the whole action stopped (state FAILED). */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // FK + the agency's recent bulk actions
    index('listing_bulk_actions_agency_created_idx').on(t.agencyId, t.createdAt),
    // one waiting or running action per member (S3-07 security review): a member cannot queue thousands of writes
    uniqueIndex('listing_bulk_actions_member_active_uq')
      .on(t.agencyId, t.createdByUserId)
      .where(sql`${t.state} in ('QUEUED', 'RUNNING')`),
    check(
      'listing_bulk_actions_counts_ck',
      sql`${t.total} = cardinality(${t.listingIds}) and ${t.processed} between 0 and ${t.total}
        and ${t.succeeded} + ${t.unchanged} + ${t.failed} = ${t.processed}`,
    ),
  ],
);

/** What a listing override rewrites (S3-10): a network listing, a new-build development or one of its units. */
export const listingOverrideTargetEnum = pgEnum('listing_override_target', ['LISTING', 'DEVELOPMENT', 'UNIT']);

/**
 * An agency's own title and/or description for a listing it may present but does not own (S3-10, PLAN §3 #54),
 * per content locale. Used only in that agency's channels (website, selections); a null field falls back to the
 * owner's text, and so does a removed override. `target_id` has no foreign key: development and unit rows belong
 * to the developments module, and an override of a listing that left the agency's view is simply never used.
 */
export const listingOverrides = pgTable(
  'listing_overrides',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    targetKind: listingOverrideTargetEnum('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    locale: text('locale').notNull(),
    title: text('title'),
    description: text('description'),
    origin: translationOriginEnum('origin').notNull().default('HUMAN'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + the agency's overrides of a set of targets in one locale (serializers) or all locales (editor)
    uniqueIndex('listing_overrides_target_locale_uq').on(t.agencyId, t.targetKind, t.targetId, t.locale),
    // every agency's overrides of a purged or deleted target (S5-F2, built CONCURRENTLY)
    index('listing_overrides_target_idx').on(t.targetKind, t.targetId),
    check('listing_overrides_locale_ck', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('listing_overrides_text_ck', sql`${t.title} is not null or ${t.description} is not null`),
    check(
      'listing_overrides_length_ck',
      sql`char_length(${t.title}) <= 200 and char_length(${t.description}) <= 20000`,
    ),
  ],
);
