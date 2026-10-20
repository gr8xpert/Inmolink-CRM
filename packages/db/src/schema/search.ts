/**
 * Tables owned by the search module (PATTERNS §2, §14). Only `packages/core/src/modules/search` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * Read models (S5-01, PLAN §5.3 #3): one precomputed document pair per listing or new-build unit and content
 * locale, so feed-api, portal and search hydration read by primary key instead of joining raw tables. Written
 * only by the search worker (`withSystem`) from outbox events; never by request handlers. They hold only
 * client-safe fields (no owner, commission or private data); white-labelling is applied per site when served.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/** LISTING: a `properties` row · UNIT: a new-build `units` row (its development's text and place). */
export const readModelKindEnum = pgEnum('read_model_kind', ['LISTING', 'UNIT']);

export const listingReadModels = pgTable(
  'listing_read_models',
  {
    /** The listing's or unit's id (UUIDv7: unique across both tables). */
    targetId: uuid('target_id').notNull(),
    locale: text('locale').notNull(),
    kind: readModelKindEnum('kind').notNull(),
    /** The owner agency: routing and filters only, never inside the documents (white-labelling, PLAN §3 #6). */
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The unit's development, or the listing's when it belongs to one. */
    developmentId: uuid('development_id'),
    /**
     * `app_public` (feed-api, portal) may read the row: a PUBLIC listing, or a unit of an OPEN development.
     * SHARED listings and PRIVATE_NETWORK units are built too (network search hydration, S5-02) but stay
     * unreadable to public paths.
     */
    public: boolean('public').notNull(),
    /** The listing's or unit's status (ACTIVE, SOLD, AVAILABLE, …): public paths filter on it. */
    status: text('status').notNull(),
    /**
     * A listing's share scope (ALL | PREFERRED: only agencies the owner prefers see it in network search, S5-02);
     * null for units. Index-only: never inside the documents.
     */
    shareScope: text('share_scope'),
    /**
     * A unit of a PRIVATE_NETWORK development: the agencies it is shared with (network search filters on it, S5-05);
     * null for listings and units of OPEN developments. Index-only: never inside the documents.
     */
    allowedAgencyIds: uuid('allowed_agency_ids').array(),
    /**
     * A PUBLIC listing hidden from the network for going unconfirmed (S3-08 freshness; S6-F2): network search leaves
     * it out in the engine, so its pages are full and its totals right. A SHARED one has no read model then. Always
     * false for units. Index-only: never inside the documents.
     */
    networkHidden: boolean('network_hidden').notNull().default(false),
    /**
     * A listing shared to PREFERRED: the agencies its owner prefers (≤ `MAX_PREFERRED_AGENCIES`), sorted — network
     * search filters on the viewer being among them (S6-F2); null otherwise. Index-only: never inside the documents.
     */
    preferredAgencyIds: uuid('preferred_agency_ids').array(),
    /**
     * Monotonic source version: the listing's `version`, or a unit's `version` + its development's `version`
     * (both only grow). An upsert never lowers it (PATTERNS §14).
     */
    version: integer('version').notNull(),
    /** Small JSON for lists and search results (`ListingCardDoc` / `UnitCardDoc`). */
    card: jsonb('card').notNull(),
    /** Full JSON for detail pages (`ListingDetailDoc` / `UnitDetailDoc`). */
    detail: jsonb('detail').notNull(),
    /** Hash of card + detail: feed-api's ETag. */
    etag: text('etag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // feed-api / portal / search hydration: a document by (target, locale)
    primaryKey({ columns: [t.targetId, t.locale], name: 'listing_read_models_pk' }),
    // FK + an agency's rebuild (`--agency`, a locale change): its rows of a kind between two of its live targets
    index('listing_read_models_agency_idx').on(t.agencyId, t.kind, t.targetId),
    // a development's change: the read models of its units (and listings) that may no longer have one
    index('listing_read_models_development_idx').on(t.developmentId).where(sql`${t.developmentId} is not null`),
    check('listing_read_models_version_ck', sql`${t.version} >= 1`),
    check(
      'listing_read_models_share_scope_ck',
      sql`${t.shareScope} is null or ${t.shareScope} in ('ALL', 'PREFERRED')`,
    ),
  ],
);

/**
 * Targets whose index document must be pushed again (S5-03, PLAN §5.3 #6): written in the same transaction as each
 * read-model change, so an update survives the search engine being down for any time. `search.syncIndex` claims rows
 * with a lease (one holder per target keeps pushes ordered), pushes the target's current document — or its removal —
 * and deletes the row only when its `generation` is unchanged (no newer change arrived meanwhile). Worker-only, every
 * agency's targets: no agency id (the push batches across agencies), no tenant access.
 */
export const searchIndexQueue = pgTable(
  'search_index_queue',
  {
    targetId: uuid('target_id').primaryKey(),
    /** Bumped by every change queued again: a claim that saw an older generation leaves the row for the next push. */
    generation: integer('generation').notNull().default(1),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    /** A sync holds the row until then; past it (the holder died) anyone may claim it. */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    /** The claim holding the row: finishing or releasing touches only rows its own claim still holds. */
    claimToken: uuid('claim_token'),
    /** Pushes tried (a document the engine keeps rejecting backs off by it). */
    attempts: integer('attempts').notNull().default(0),
    /** A document the engine rejected waits until then (a new change of the target clears it). */
    notBefore: timestamp('not_before', { withTimezone: true }),
  },
  (t) => [
    // claim: oldest first
    index('search_index_queue_queued_idx').on(t.queuedAt),
  ],
);

/**
 * Read-model rebuild queue (S5-F4): listings and units whose read models must be rebuilt, written by the search
 * subscriptions (one row per target, however many events) and drained by `search.buildReadModels` in batches of
 * `READ_MODEL_BATCH` per transaction, per agency (fair share). Worker-only (`withSystem`), no tenant access.
 */
export const readModelQueue = pgTable(
  'read_model_queue',
  {
    targetId: uuid('target_id').primaryKey(),
    /** LISTING | UNIT */
    kind: text('kind').notNull(),
    /** The target's agency: the rebuild job's fair-share group (not an access boundary: the table is worker-only). */
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    /** Bumped by every change queued again: a rebuild that claimed an older generation leaves the row queued. */
    generation: integer('generation').notNull().default(1),
    /** Debounce: a burst of changes to one target is rebuilt once, after its last change settled. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull().defaultNow(),
    /** Images still processing: rebuilds left (a recheck pushes `due_at` a minute on). A change resets it. */
    rechecks: integer('rechecks').notNull().default(0),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    claimToken: uuid('claim_token'),
  },
  (t) => [
    // claim: an agency's due targets, oldest first; the sweep's agencies with due rows
    index('read_model_queue_agency_due_idx').on(t.ownerAgencyId, t.dueAt),
  ],
);

/**
 * Postgres fallback search (S5-04, PLAN §5.4, ADR 0005 #5): the PUBLIC listings index documents as rows, so website
 * search keeps answering basic filters when the engine is down or slow. Written with the read models in the same
 * transaction (never stale); a target that is not PUBLIC has no row. Mirrors `ListingIndexDoc` field for field (the
 * same engine-neutral filter compiles to either), without the text — the fallback matches references only.
 *
 * Global, not tenant-scoped: every row is a PUBLIC listing or unit, readable by public paths like the documents
 * themselves. Not under RLS on purpose: array (`&&`, `@>`) and `numeric` comparisons are not leakproof, so under a
 * policy they could never be index conditions. `owner_agency_id` is a filter only, never served.
 */
export const listingSearchDocs = pgTable(
  'listing_search_docs',
  {
    targetId: uuid('target_id').primaryKey(),
    kind: readModelKindEnum('kind').notNull(),
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    developmentId: uuid('development_id'),
    status: text('status').notNull(),
    transactionType: text('transaction_type').notNull(),
    propertyTypeId: uuid('property_type_id').notNull(),
    /** Country, region, city and area ids (a filter on any level matches everything below it). */
    locationIds: uuid('location_ids').array().notNull(),
    featureIds: uuid('feature_ids').array().notNull(),
    /** Null when the price is on request. */
    priceCents: bigint('price_cents', { mode: 'number' }),
    priceOnRequest: boolean('price_on_request').notNull(),
    beds: integer('beds'),
    baths: integer('baths'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2, mode: 'number' }),
    plotM2: numeric('plot_m2', { precision: 12, scale: 2, mode: 'number' }),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    ref: text('ref').notNull(),
    /**
     * The target's opaque public code (S7-02, `listing_public_codes`): a site shows network documents as
     * `<prefix>-<code>` and a visitor finds them by it. Null until the target's first rebuild with S7-02.
     */
    publicCode: text('public_code'),
    /**
     * Network sharing, as in the index document (S7-01: sites showing network listings). Null on rows written before
     * the columns existed: such a row is no one's network listing until a rebuild rewrites it.
     */
    shareScope: text('share_scope'),
    preferredAgencyIds: uuid('preferred_agency_ids').array(),
    networkHidden: boolean('network_hidden'),
    /** Epoch seconds, as in the index document ("newest" sort and its keyset cursor). */
    publishedAt: bigint('published_at', { mode: 'number' }).notNull(),
    version: integer('version').notNull(),
    /** The index document's `sourceHash`: an unchanged rebuild writes nothing. */
    sourceHash: text('source_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // an agency website, newest first (and any other sort within one agency's few thousand rows)
    index('listing_search_docs_owner_idx').on(t.ownerAgencyId, t.publishedAt, t.targetId),
    // network-wide pages, newest first
    index('listing_search_docs_newest_idx').on(t.publishedAt, t.targetId),
    // network-wide pages by price
    index('listing_search_docs_price_idx').on(t.priceCents, t.targetId),
    // network-wide pages by bedrooms and by area
    index('listing_search_docs_beds_idx').on(t.beds, t.targetId),
    index('listing_search_docs_area_idx').on(t.areaM2, t.targetId),
    // rare transaction types and statuses network-wide (short-term rentals, reserved units): common ones stop a
    // capped scan early, rare ones would read the whole table without it
    index('listing_search_docs_transaction_idx').on(t.transactionType, t.status),
    // type filters (ANDed with the location and feature bitmaps before the heap is read)
    index('listing_search_docs_type_idx').on(t.propertyTypeId),
    // location and feature filters (`@>`, `&&`)
    index('listing_search_docs_locations_idx').using('gin', t.locationIds),
    index('listing_search_docs_features_idx').using('gin', t.featureIds),
    // a development's units
    index('listing_search_docs_development_idx').on(t.developmentId).where(sql`${t.developmentId} is not null`),
    // a reference typed in the search box
    index('listing_search_docs_ref_idx').on(sql`lower(${t.ref})`),
    // a network listing's site reference typed in the search box (S7-02; built CONCURRENTLY, concurrent-indexes.ts)
    index('listing_search_docs_public_code_idx').on(t.publicCode).where(sql`${t.publicCode} is not null`),
    // map view (a box: a lat range, lng checked in the index)
    index('listing_search_docs_geo_idx').on(t.lat, t.lng).where(sql`${t.lat} is not null`),
  ],
);

/**
 * Public codes (S7-02, PLAN §3 #6 white-label): one opaque, random code per listing or unit, made when its read
 * models are first written and never changed or reused. Websites show another agency's listing as
 * `<site prefix>-<code>` — never the owner's own reference, which the owner shows on its own site and portals — and
 * the website API finds a listing by it. No foreign key: targets live in other modules; a purged target's code stays
 * (never reused). Global and public: a code is shown on public pages.
 */
export const listingPublicCodes = pgTable(
  'listing_public_codes',
  {
    targetId: uuid('target_id').primaryKey(),
    /** 8 Crockford base32 characters, upper case. */
    code: text('code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `/v2/listings/{ref}` and a typed reference: a code → its target
    uniqueIndex('listing_public_codes_code_uq').on(t.code),
    check('listing_public_codes_code_ck', sql`${t.code} ~ '^[0-9A-HJKMNP-TV-Z]{8}$'`),
  ],
);

/**
 * Total commission of a PUBLIC target in basis points of its price (S7-F4: a CUSTOM site's minimum commission on
 * network listings). Worker-written (`withSystem`); no role but `app_system` reads it. The website fallback reaches
 * it only through `public.search_commission_at_least(target_id, bp)` (SECURITY DEFINER, answers a boolean for one
 * target), so no public path can select the value. A target without a known commission has no row.
 */
export const listingSearchCommissions = pgTable('listing_search_commissions', {
  targetId: uuid('target_id').primaryKey(),
  commissionBp: integer('commission_bp').notNull(),
});
