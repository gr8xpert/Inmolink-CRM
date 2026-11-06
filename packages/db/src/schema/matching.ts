import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  halfvec,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Tables owned by the matching module (PATTERNS §2). Only `packages/core/src/modules/matching` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * S5-06 (PLAN §7 M9): an agent's saved searches and the alerts they raised — a listing new on the market, its price
 * dropped, or back on the market — plus the last state matching saw of each listing (to tell those apart).
 */

/**
 * An agent's saved search (S5-06): the search vocabulary of network search (transaction type, taxonomy ids, ranges),
 * which listings it watches (`scope`) and how it alerts (`frequency`, `alert_*`). The member's own: colleagues neither
 * read nor change it.
 *
 * `match_keys` is the inverse index of the matching worker (`matching.matchListings`): one `<transaction>:<location>`
 * key per pair of the search, `*` for either one left open — a listing's keys are its transaction type and `*` times
 * each of its location ids (country, region, city, area) and `*`, so `match_keys && <listing's keys>` on the GIN index
 * finds the only searches that could match it, never a walk over all of them. Written by the service from the
 * columns, never by a client.
 */
export const savedSearches = pgTable(
  'saved_searches',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The agent who saved it and gets its alerts. */
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    /** `OWN`: the agency's own listings · `NETWORK`: other agencies' listings shared with it · `ALL`: both. */
    scope: text('scope').notNull().default('ALL'),
    /** `INSTANT`: a notification per alert · `DAILY`: one digest a day · `OFF`: saved, no alerts. */
    frequency: text('frequency').notNull().default('INSTANT'),
    alertNew: boolean('alert_new').notNull().default(true),
    alertPriceDrop: boolean('alert_price_drop').notNull().default(true),
    alertBackOnMarket: boolean('alert_back_on_market').notNull().default(true),
    /** Null: any. */
    transactionType: text('transaction_type'),
    /** Empty: any. */
    propertyTypeIds: uuid('property_type_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Empty: anywhere; else a listing at or under one of them. */
    locationIds: uuid('location_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Every one of them (empty: none required). */
    featureIds: uuid('feature_ids').array().notNull().default(sql`'{}'::uuid[]`),
    priceMinCents: bigint('price_min_cents', { mode: 'number' }),
    priceMaxCents: bigint('price_max_cents', { mode: 'number' }),
    bedsMin: integer('beds_min'),
    bathsMin: integer('baths_min'),
    areaMinM2: numeric('area_min_m2', { precision: 10, scale: 2, mode: 'number' }),
    areaMaxM2: numeric('area_max_m2', { precision: 10, scale: 2, mode: 'number' }),
    matchKeys: text('match_keys').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the member's saved searches: where agency_id = ? and user_id = ? order by created_at, id
    index('saved_searches_user_idx').on(t.agencyId, t.userId, t.createdAt, t.id),
    // the matching worker's candidates: where match_keys && ? and frequency <> 'OFF' (any agency)
    index('saved_searches_match_keys_idx').using('gin', t.matchKeys).where(sql`${t.frequency} <> 'OFF'`),
    check('saved_searches_name_ck', sql`char_length(${t.name}) between 1 and 80`),
    check('saved_searches_scope_ck', sql`${t.scope} in ('ALL', 'OWN', 'NETWORK')`),
    check('saved_searches_frequency_ck', sql`${t.frequency} in ('INSTANT', 'DAILY', 'OFF')`),
    check(
      'saved_searches_transaction_ck',
      sql`${t.transactionType} is null or ${t.transactionType} in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')`,
    ),
    check(
      'saved_searches_arrays_ck',
      sql`cardinality(${t.propertyTypeIds}) <= 20 and cardinality(${t.locationIds}) <= 20
        and cardinality(${t.featureIds}) <= 20 and cardinality(${t.matchKeys}) between 1 and 21`,
    ),
    check(
      'saved_searches_price_ck',
      sql`${t.priceMinCents} is null or ${t.priceMaxCents} is null or ${t.priceMinCents} <= ${t.priceMaxCents}`,
    ),
    check(
      'saved_searches_area_ck',
      sql`${t.areaMinM2} is null or ${t.areaMaxM2} is null or ${t.areaMinM2} <= ${t.areaMaxM2}`,
    ),
  ],
);

/**
 * One alert of a saved search about one listing (S5-06), written by the matching worker. Exactly one per saved search,
 * listing, kind and listing state (`dedupe_key`: 0 for NEW — a listing is new once — else the listing's version that
 * dropped the price or came back): a redelivered event, a retried job or two rebuilds of the same change raise
 * nothing more (`saved_search_alerts_dedupe_uq`). `notified_at` is set when the alert went out as a notification
 * (instantly, or in its search's daily digest). Pruned after 90 days; at most `ALERT_DAILY_CAP` per search a day (S13-F9).
 */
export const savedSearchAlerts = pgTable(
  'saved_search_alerts',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    userId: uuid('user_id').notNull(),
    savedSearchId: uuid('saved_search_id')
      .notNull()
      .references(() => savedSearches.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').notNull(),
    kind: text('kind').notNull(),
    dedupeKey: integer('dedupe_key').notNull(),
    /** The listing's reference as the agent sees it, for the notification. */
    ref: text('ref').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }),
    previousPriceCents: bigint('previous_price_cents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [
    // exactly one alert per saved search, listing, kind and listing state (insert … on conflict do nothing)
    uniqueIndex('saved_search_alerts_dedupe_uq').on(t.savedSearchId, t.listingId, t.kind, t.dedupeKey),
    // the daily digest: where agency_id = ? and notified_at is null order by saved_search_id, id
    index('saved_search_alerts_pending_idx').on(t.agencyId, t.savedSearchId, t.id).where(sql`${t.notifiedAt} is null`),
    // the 90-day prune: where created_at < ? limit ?
    index('saved_search_alerts_created_idx').on(t.createdAt),
    // S13-F9, the per-search daily cap: where saved_search_id = ? and created_at >= ? limit <cap>
    index('saved_search_alerts_search_created_idx').on(t.savedSearchId, t.createdAt),
    check('saved_search_alerts_kind_ck', sql`${t.kind} in ('NEW', 'PRICE_DROP', 'BACK_ON_MARKET')`),
  ],
);

/**
 * The last state of each listing the matching worker saw (S5-06): its status (`GONE` when it no longer has a read
 * model — withdrawn, deleted, private), price and version. A rebuild compares the listing's new read model with it to
 * tell a new listing, a price drop and a return to the market from any other change. Owned by the listing's agency;
 * read and written by the worker only.
 */
export const matchingListingStates = pgTable(
  'matching_listing_states',
  {
    listingId: uuid('listing_id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    status: text('status').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }),
    version: integer('version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // agency_id leads the FK index (the agency's states)
    index('matching_listing_states_agency_idx').on(t.agencyId),
    // the prune of listings gone long ago: where status = 'GONE' and updated_at < ? limit ?
    index('matching_listing_states_gone_idx').on(t.updatedAt).where(sql`${t.status} = 'GONE'`),
  ],
);

/**
 * R2-01b: the size of a client-profile embedding — the listing embeddings' (`LISTING_EMBEDDING_DIMENSIONS`), since the
 * match engine scores a profile's vector against listing vectors (one space, one model). A test pins them equal.
 */
export const CLIENT_PROFILE_EMBEDDING_DIMENSIONS = 1024;

/**
 * A client's search profile (R2-01b, PLAN §7 M9, §3 #23): what a buyer or tenant (a CRM contact of the agency) is
 * looking for — hard criteria in the saved-search vocabulary (transaction, taxonomy ids, ranges) and free-text wishes —
 * and how the match engine (R2-02) works it: `mode` (`OFF` · `REVIEW`: matches wait for the agent · `AUTO_SEND`) and
 * `frequency`. R2-01b adds the table and its embedding; R2-02 adds the service, routes, engine and UI, and with them
 * the contact merge and erasure handling (no profile is written before R2-02).
 *
 * The agency's own (STRICT): wishes are client data, never shown to another agency or in Client Mode. `contact_id`
 * points at crm's `contacts` (no FK: another module's table; R2-02 follows merges and erasures). `version` moves on
 * every change and is the embedding's `source_version`.
 */
export const clientProfiles = pgTable(
  'client_profiles',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The client (a crm contact of this agency). */
    contactId: uuid('contact_id').notNull(),
    /** `OFF` (kept, never matched or embedded) · `REVIEW` · `AUTO_SEND`. */
    mode: text('mode').notNull().default('OFF'),
    /** `INSTANT` · `DAILY` · `WEEKLY` (how often matches go out or wait for review). */
    frequency: text('frequency').notNull().default('DAILY'),
    /** Null: any. */
    transactionType: text('transaction_type'),
    /** Empty: any. */
    propertyTypeIds: uuid('property_type_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Empty: anywhere; else a listing at or under one of them. */
    locationIds: uuid('location_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Must-haves (empty: none). */
    featureIds: uuid('feature_ids').array().notNull().default(sql`'{}'::uuid[]`),
    priceMinCents: bigint('price_min_cents', { mode: 'number' }),
    priceMaxCents: bigint('price_max_cents', { mode: 'number' }),
    bedsMin: integer('beds_min'),
    bathsMin: integer('baths_min'),
    areaMinM2: numeric('area_min_m2', { precision: 10, scale: 2, mode: 'number' }),
    areaMaxM2: numeric('area_max_m2', { precision: 10, scale: 2, mode: 'number' }),
    /** The client's wishes in their words ("sea view, walk to the beach, quiet street"); internal. */
    wishes: text('wishes'),
    /**
     * R2-02b: the match engine's inverse index (`matching/match-keys.ts` `profileMatchKeys`): `a:<agency>:<tx>:<loc>`
     * (its agency's own listings) and `n:<tx>:<loc>` (network listings) per place (`*`: anywhere) and transaction
     * (`*`: any). A changed listing probes `client_profiles_match_keys_idx` with its own keys (`listingMatchKeys`), so
     * only profiles that could see it at one of its places are read. Written by the repo from the columns.
     */
    matchKeys: text('match_keys').array().notNull().default(sql`'{}'::text[]`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // a contact's profiles: where agency_id = ? and contact_id = ? order by created_at, id
    index('client_profiles_contact_idx').on(t.agencyId, t.contactId, t.createdAt, t.id),
    // the embedding backfill walk: where agency_id = ? and id > ? order by id limit ? (also the FK index)
    uniqueIndex('client_profiles_agency_id_uq').on(t.agencyId, t.id),
    // R2-02b, the match engine's listing -> profiles probe: where match_keys && ? and mode <> 'OFF' (any agency)
    index('client_profiles_match_keys_idx').using('gin', t.matchKeys).where(sql`${t.mode} <> 'OFF'`),
    check('client_profiles_mode_ck', sql`${t.mode} in ('OFF', 'REVIEW', 'AUTO_SEND')`),
    check('client_profiles_frequency_ck', sql`${t.frequency} in ('INSTANT', 'DAILY', 'WEEKLY')`),
    check(
      'client_profiles_transaction_ck',
      sql`${t.transactionType} is null or ${t.transactionType} in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')`,
    ),
    check(
      'client_profiles_arrays_ck',
      sql`cardinality(${t.propertyTypeIds}) <= 20 and cardinality(${t.locationIds}) <= 20
        and cardinality(${t.featureIds}) <= 20`,
    ),
    check(
      'client_profiles_price_ck',
      sql`${t.priceMinCents} is null or ${t.priceMaxCents} is null or ${t.priceMinCents} <= ${t.priceMaxCents}`,
    ),
    check(
      'client_profiles_area_ck',
      sql`${t.areaMinM2} is null or ${t.areaMaxM2} is null or ${t.areaMinM2} <= ${t.areaMaxM2}`,
    ),
    check('client_profiles_wishes_ck', sql`${t.wishes} is null or char_length(${t.wishes}) <= 2000`),
    check('client_profiles_version_ck', sql`${t.version} >= 1`),
  ],
);

/**
 * Client-profile embeddings (R2-01b, PLAN §8 #4): one vector per active profile (`mode` not `OFF`), from its criteria
 * as words and its wishes with contact details removed (`matching/profile-embeddings.ts`), for the match engine's
 * semantic score (R2-02). Same model and size as `listing_embeddings`; written by the matching worker only.
 *
 * `content_hash` = sha256(model, text): an unchanged text is never embedded again (a price, mode or frequency edit only
 * moves `source_version` on). `fillfactor = 80` (migration): those touches stay HOT and never re-insert into the graph.
 * Global, worker-only like `listing_embeddings`: matching runs across agencies; `owner_agency_id` is the fair-share
 * group and the backfill's walk. No tenant or public role reads it.
 */
export const clientProfileEmbeddings = pgTable(
  'client_profile_embeddings',
  {
    profileId: uuid('profile_id').primaryKey(),
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    embedding: halfvec('embedding', { dimensions: CLIENT_PROFILE_EMBEDDING_DIMENSIONS }).notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    /** The profile's version this row was last checked against: a write never goes back below it. */
    sourceVersion: integer('source_version').notNull(),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // profiles nearest a listing's vector (cosine `<=>`): the engine's candidates beyond the hard filters (R2-02)
    index('client_profile_embeddings_hnsw_idx').using('hnsw', t.embedding.op('halfvec_cosine_ops')),
    // the backfill's orphan sweep: an agency's rows in a profile window
    index('client_profile_embeddings_owner_idx').on(t.ownerAgencyId, t.profileId),
    check('client_profile_embeddings_version_ck', sql`${t.sourceVersion} >= 1`),
  ],
);

/**
 * The listings the match engine can offer (R2-02b, PLAN §7 M9): one row per ACTIVE listing with a read model, its
 * criteria as the read model has them (`search.indexDocsFor`, CLAUDE.md rule 9 — never the raw tables) and who may see
 * it on the network. Written by the matching worker on `search.listings.changed` (a listing no longer ACTIVE or without
 * a read model is deleted) and by its backfill; read by the profile → listings direction (a profile's change, the
 * nightly sweep) over `match_keys` (`listingMatchKeys`: `a:<owner>:…` always, `n:…` unless hidden from the network).
 * Owned by the listing's agency; worker-only (no request reads or writes it).
 */
export const matchingListingFacts = pgTable(
  'matching_listing_facts',
  {
    listingId: uuid('listing_id').primaryKey(),
    /** The owner. */
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The read models' version these facts are from: a write never goes back below it. */
    version: integer('version').notNull(),
    transactionType: text('transaction_type').notNull(),
    propertyTypeId: uuid('property_type_id').notNull(),
    /** Country, region, city and area ids. */
    locationIds: uuid('location_ids').array().notNull(),
    featureIds: uuid('feature_ids').array().notNull(),
    /** Null: price on request. */
    priceCents: bigint('price_cents', { mode: 'number' }),
    beds: integer('beds'),
    baths: integer('baths'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2, mode: 'number' }),
    /** `ALL` or `PREFERRED` (then only `preferred_agency_ids` see it on the network). */
    shareScope: text('share_scope').notNull(),
    preferredAgencyIds: uuid('preferred_agency_ids').array().notNull().default(sql`'{}'::uuid[]`),
    matchKeys: text('match_keys').array().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the profile → listings probe: where match_keys && <profile's keys> (newest listing ids first, bounded)
    index('matching_listing_facts_match_keys_idx').using('gin', t.matchKeys),
    // agency_id leads the FK index (the owner's facts)
    index('matching_listing_facts_agency_idx').on(t.agencyId, t.listingId),
    // broad profiles' window (order by updated_at desc limit ?) and the sweep's narrow probes (updated_at >= ?)
    index('matching_listing_facts_updated_idx').on(t.updatedAt),
    check('matching_listing_facts_share_ck', sql`${t.shareScope} in ('ALL', 'PREFERRED')`),
    check('matching_listing_facts_version_ck', sql`${t.version} >= 1`),
  ],
);

/**
 * A listing the match engine found for a client profile (R2-02b, PLAN §7 M9, §3 #23): one row per profile and listing
 * ever (`client_profile_matches_pair_uq`) — a client never gets the same listing twice: a re-run, a listing's later
 * change or a dismissal never writes the pair again (insert … on conflict do nothing). The score's parts (hard fit,
 * semantic — null when either vector is missing, the total then uses the neutral score —, the learned boost of R2-02c,
 * total), the structured explanation (`MatchExplanation`: each criterion satisfied or not, the price delta, must-haves
 * met) and its status: `PENDING_REVIEW` (REVIEW profiles: waits for the agent, R2-02d) · `QUEUED` (AUTO_SEND: R2-02e
 * sends it) · `SENT` · `DISMISSED` · `EXPIRED` (the listing went before it was sent) · `APPROVED` (R2-02d: a member
 * put it in a selection for the client, `selection_id`; nothing sent). The profile's agency's own; inserted by the
 * matching worker only — R2-02d's review queue (`app_user`) changes only `status`, `selection_id` and `updated_at`,
 * along the review moves its guard trigger allows (migration 0189), and never deletes a row.
 */
export const clientProfileMatches = pgTable(
  'client_profile_matches',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => clientProfiles.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').notNull(),
    /** The listing's owner when matched (the agency itself, or a network agency). */
    listingAgencyId: uuid('listing_agency_id').notNull(),
    /** The listing's read-model version that matched. */
    listingVersion: integer('listing_version').notNull(),
    /** The profile's version that matched. */
    profileVersion: integer('profile_version').notNull(),
    hardScore: real('hard_score').notNull(),
    /** Null: no vector on one side (the total used the neutral score). */
    semanticScore: real('semantic_score'),
    /** R2-02c's learned boost (0 until then). */
    boostScore: real('boost_score').notNull().default(0),
    totalScore: real('total_score').notNull(),
    explanation: jsonb('explanation').notNull(),
    status: text('status').notNull(),
    /** R2-02d: the selection an `APPROVED` match was added to (presentations; no FK across modules). */
    selectionId: uuid('selection_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // never twice: one row per profile and listing, whatever its status (also the profile FK index)
    uniqueIndex('client_profile_matches_pair_uq').on(t.profileId, t.listingId),
    // a profile's queue (R2-02d/e): where agency_id = ? and profile_id = ? and status = ? order by created_at, id
    index('client_profile_matches_queue_idx').on(t.agencyId, t.profileId, t.status, t.createdAt, t.id),
    // the agency's review queue (R2-02d): where agency_id = ? and status = ? order by created_at, id
    index('client_profile_matches_agency_status_idx').on(t.agencyId, t.status, t.createdAt, t.id),
    check(
      'client_profile_matches_status_ck',
      sql`${t.status} in ('PENDING_REVIEW', 'QUEUED', 'SENT', 'DISMISSED', 'EXPIRED', 'APPROVED')`,
    ),
    check(
      'client_profile_matches_scores_ck',
      sql`${t.hardScore} between 0 and 1 and (${t.semanticScore} is null or ${t.semanticScore} between 0 and 1)`,
    ),
  ],
);

/**
 * R2-02c, the learned boost's ledger: one feedback signal per client profile and listing — `LIKE` (the client's latest
 * word on the listing across the selections of the profile's contact is a like) or `DISLIKE` (a member dismissed the
 * match) — at `signal_at` (when it was given: an older event never overwrites a newer signal), an unlike or a restored
 * match takes its signal back. `keys` are the listing's affinity keys when the signal was given (`boost.ts`: hashes of
 * the property type, places, features and price band — no client data), so a change takes back exactly what it added
 * to `client_profile_affinities`. The profile's agency's own; written by the matching worker only; goes with the
 * profile (FK cascade: profile delete, contact erasure, agency erasure; a contact merge moves the profile itself).
 */
export const clientProfileFeedback = pgTable(
  'client_profile_feedback',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => clientProfiles.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id').notNull(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    signal: text('signal').notNull(),
    signalAt: timestamp('signal_at', { withTimezone: true }).notNull(),
    keys: integer('keys').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one signal per profile and listing (also the profile FK index): where profile_id = any(?) and listing_id = ?
    primaryKey({ columns: [t.profileId, t.listingId] }),
    // FK (agency's rows)
    index('client_profile_feedback_agency_idx').on(t.agencyId),
    check('client_profile_feedback_signal_ck', sql`${t.signal} in ('LIKE', 'DISLIKE')`),
  ],
);

/**
 * R2-02c, the learned boost's summary: one row per client profile with feedback — parallel arrays, sorted by key, of
 * affinity key hashes (`boost.ts` `affinityKey`: the dimension in the low 2 bits) and how many liked / disliked
 * listings carried each. At most `MAX_AFFINITY_KEYS` keys (≈ 1.5 KB: stored inline, never TOASTed), so the engine's
 * batch read (`profile_id = any(?)`, one row a profile) stays small. Kept up to date from `client_profile_feedback`
 * by deltas under the profile's lock. Numbers only. Goes with the profile (FK cascade).
 */
export const clientProfileAffinities = pgTable(
  'client_profile_affinities',
  {
    profileId: uuid('profile_id')
      .primaryKey()
      .references(() => clientProfiles.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    keys: integer('keys').array().notNull(),
    likes: integer('likes').array().notNull(),
    dislikes: integer('dislikes').array().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK (agency's rows); the engine's batch read is the primary key (profile_id = any(?))
    index('client_profile_affinities_agency_idx').on(t.agencyId),
    check(
      'client_profile_affinities_arrays_ck',
      sql`cardinality(${t.keys}) = cardinality(${t.likes}) and cardinality(${t.keys}) = cardinality(${t.dislikes})`,
    ),
  ],
);
