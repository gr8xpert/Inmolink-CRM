import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Tables owned by the network module (PATTERNS §2). Only `packages/core/src/modules/network` imports this file
 * (`pnpm check:boundaries`).
 *
 * S11-05, the network board (AMS, PLAN §3 #24, §7 M11):
 * - `network_posts` — an agency's post (buyer request, property offer, distressed sale, developer announcement) with
 *   structured criteria in the search vocabulary (transaction type, taxonomy ids, ranges) and an expiry. NETWORK_READ:
 *   verified agencies read the OPEN, unexpired ones — whole rows, so nothing private lives here: no author, no client,
 *   no commission, only what the poster chose to publish.
 * - `network_post_authors` — the post's private side (STRICT): who posted it and its `Idempotency-Key`.
 * - `network_subscriptions` — a member's filters: posts of other agencies that match them notify the member.
 */

export const networkPosts = pgTable(
  'network_posts',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    id: uuid('id').primaryKey(),
    /** `BUYER_REQUEST`, `PROPERTY_OFFER`, `DISTRESSED` or `DEVELOPER_ANNOUNCEMENT`. */
    kind: text('kind').notNull(),
    /** `OPEN` or `CLOSED` (the poster closed it). An expired post stays `OPEN` and is read by nobody else. */
    status: text('status').notNull().default('OPEN'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    transactionType: text('transaction_type'),
    propertyTypeIds: uuid('property_type_ids').array(),
    /** The locations the poster chose. */
    locationIds: uuid('location_ids').array(),
    /** `location_ids` and their ancestors: a subscription to a city matches a post about one of its areas. */
    locationScopeIds: uuid('location_scope_ids').array(),
    featureIds: uuid('feature_ids').array(),
    priceMinCents: bigint('price_min_cents', { mode: 'number' }),
    priceMaxCents: bigint('price_max_cents', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    bedsMin: integer('beds_min'),
    bathsMin: integer('baths_min'),
    areaMinM2: numeric('area_min_m2', { precision: 10, scale: 2, mode: 'number' }),
    areaMaxM2: numeric('area_max_m2', { precision: 10, scale: 2, mode: 'number' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    // the board, newest first: where status = 'OPEN' and expires_at > now() and (created_at, id) < (?, ?)
    index('network_posts_open_idx').on(t.createdAt, t.id).where(sql`${t.status} = 'OPEN'`),
    // the board filtered by kind: where kind = ? and status = 'OPEN' … order by created_at desc, id desc
    index('network_posts_open_kind_idx').on(t.kind, t.createdAt, t.id).where(sql`${t.status} = 'OPEN'`),
    // the agency's own posts: where agency_id = ? and (created_at, id) < (?, ?)
    index('network_posts_agency_idx').on(t.agencyId, t.createdAt, t.id),
    // the expiry sweep: where status = 'OPEN' and expires_at <= now() order by expires_at, id
    index('network_posts_expiry_idx').on(t.expiresAt, t.id).where(sql`${t.status} = 'OPEN'`),
    // the target of `network_post_authors`' (agency_id, post_id) foreign key: an author row names its own agency's post
    uniqueIndex('network_posts_agency_id_uq').on(t.agencyId, t.id),
    check(
      'network_posts_kind_ck',
      sql`${t.kind} in ('BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT')`,
    ),
    check('network_posts_status_ck', sql`${t.status} in ('OPEN', 'CLOSED')`),
    check('network_posts_closed_ck', sql`(${t.status} = 'CLOSED') = (${t.closedAt} is not null)`),
    check('network_posts_title_ck', sql`char_length(${t.title}) between 1 and 120`),
    check('network_posts_body_ck', sql`char_length(${t.body}) between 1 and 2000`),
    check(
      'network_posts_transaction_ck',
      sql`${t.transactionType} is null or ${t.transactionType} in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')`,
    ),
    check(
      'network_posts_arrays_ck',
      sql`coalesce(cardinality(${t.propertyTypeIds}), 0) <= 20 and coalesce(cardinality(${t.locationIds}), 0) <= 20
        and coalesce(cardinality(${t.locationScopeIds}), 0) <= 100 and coalesce(cardinality(${t.featureIds}), 0) <= 20`,
    ),
    check(
      'network_posts_price_ck',
      sql`(${t.priceMinCents} is null or ${t.priceMinCents} >= 0) and (${t.priceMaxCents} is null or ${t.priceMaxCents} >= 0)
        and (${t.priceMinCents} is null or ${t.priceMaxCents} is null or ${t.priceMinCents} <= ${t.priceMaxCents})`,
    ),
    check(
      'network_posts_area_ck',
      sql`${t.areaMinM2} is null or ${t.areaMaxM2} is null or ${t.areaMinM2} <= ${t.areaMaxM2}`,
    ),
    check(
      'network_posts_rooms_ck',
      sql`(${t.bedsMin} is null or ${t.bedsMin} between 0 and 50) and (${t.bathsMin} is null or ${t.bathsMin} between 0 and 50)`,
    ),
    check('network_posts_expiry_ck', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const networkPostAuthors = pgTable(
  'network_post_authors',
  {
    agencyId: uuid('agency_id').notNull(),
    postId: uuid('post_id').notNull(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    idempotencyHash: text('idempotency_hash'),
    requestHash: text('request_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the FK's index, and the author lookups: where agency_id = ? and post_id = ?
    primaryKey({ name: 'network_post_authors_pk', columns: [t.agencyId, t.postId] }),
    foreignKey({
      name: 'network_post_authors_post_fk',
      columns: [t.agencyId, t.postId],
      foreignColumns: [networkPosts.agencyId, networkPosts.id],
    }),
    // POST replay: where agency_id = ? and idempotency_hash = ? (unique for good: a key reused later is refused)
    uniqueIndex('network_post_authors_idempotency_uq')
      .on(t.agencyId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
  ],
);

export const networkSubscriptions = pgTable(
  'network_subscriptions',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    id: uuid('id').notNull(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    /** Null: every kind. */
    kinds: text('kinds').array(),
    transactionType: text('transaction_type'),
    propertyTypeIds: uuid('property_type_ids').array(),
    locationIds: uuid('location_ids').array(),
    priceMinCents: bigint('price_min_cents', { mode: 'number' }),
    priceMaxCents: bigint('price_max_cents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the worker's walk over every subscription: where (agency_id, id) > (?, ?) order by agency_id, id
    primaryKey({ name: 'network_subscriptions_pk', columns: [t.agencyId, t.id] }),
    // the member's subscriptions: where agency_id = ? and user_id = ? order by created_at, id
    index('network_subscriptions_user_idx').on(t.agencyId, t.userId, t.createdAt, t.id),
    check('network_subscriptions_name_ck', sql`char_length(${t.name}) between 1 and 80`),
    check(
      'network_subscriptions_kinds_ck',
      sql`${t.kinds} is null or (cardinality(${t.kinds}) between 1 and 4
        and ${t.kinds} <@ array['BUYER_REQUEST', 'PROPERTY_OFFER', 'DISTRESSED', 'DEVELOPER_ANNOUNCEMENT']::text[])`,
    ),
    check(
      'network_subscriptions_transaction_ck',
      sql`${t.transactionType} is null or ${t.transactionType} in ('SALE', 'RENT_LONG_TERM', 'RENT_SHORT_TERM')`,
    ),
    check(
      'network_subscriptions_arrays_ck',
      sql`coalesce(cardinality(${t.propertyTypeIds}), 0) <= 20 and coalesce(cardinality(${t.locationIds}), 0) <= 20`,
    ),
    check(
      'network_subscriptions_price_ck',
      sql`${t.priceMinCents} is null or ${t.priceMaxCents} is null or ${t.priceMinCents} <= ${t.priceMaxCents}`,
    ),
  ],
);
