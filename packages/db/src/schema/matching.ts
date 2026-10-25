import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
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
