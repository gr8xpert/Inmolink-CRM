/**
 * Tables owned by the dedupe module (PATTERNS §2). Only `packages/core/src/modules/dedupe` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * R2-03a (PLAN §10, §3 #13): duplicate detection across agencies. A listing's signature (its facts from the read
 * models, its image hashes from the media pipeline and its blocking keys) and the scored candidate pairs. Both are
 * global and worker-only, like `listing_embeddings`: duplicates span agencies, so the dedupe worker (`withSystem`)
 * reads every agency's signatures; no tenant, member or public role reads either table (`noUserRead`), so no agency
 * sees another's listings through them. R2-03b builds clusters and the review queue on the pairs.
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
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * One row per ACTIVE listing with a read model (R2-03a): what pair scoring compares, and the blocking keys candidate
 * generation probes (`block_keys && <keys>` on the GIN index; never all pairs). Keys are 64-bit hashes of
 * `img:<sha256>` (an exact image), `ph:<band>:<16 bits>:<city>` (a pHash LSH band, per city) and
 * `geo:<cell>:<transaction>:<type>:<beds>` (a ~150 m grid cell; the probe asks for the 3 × 3 neighbourhood, and
 * beds ± 1 in its own cell). `image_keys` / `phashes` hold the listing's first images (display order, capped) for the image signals.
 * Written by the dedupe worker from `search.indexDocsFor` (rule 9) and `media.listingImageHashes`; a listing no longer
 * ACTIVE or without a read model is deleted with its pairs.
 */
export const dedupeListingSignatures = pgTable(
  'dedupe_listing_signatures',
  {
    listingId: uuid('listing_id').primaryKey(),
    /** The owner (fair-share group; never shown to another agency). */
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    /** The read models' version this signature is from: a write never goes back below it. */
    sourceVersion: integer('source_version').notNull(),
    /** How the keys were built (`SIGNATURE_VERSION`): a new version rebuilds every signature through the backfill. */
    signatureVersion: smallint('signature_version').notNull(),
    transactionType: text('transaction_type').notNull(),
    propertyTypeId: uuid('property_type_id').notNull(),
    /** The city-level place (the pHash bands' scope); null when the listing has none. */
    cityId: uuid('city_id'),
    beds: integer('beds'),
    baths: integer('baths'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2, mode: 'number' }),
    /** Null: price on request. */
    priceCents: bigint('price_cents', { mode: 'number' }),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    /** The first 64 bits of each image's SHA-256 (display order, at most `MAX_IMAGES`). */
    imageKeys: bigint('image_keys', { mode: 'bigint' }).array().notNull(),
    /** Each image's 64-bit pHash, in the same order as `image_keys` (0 when the pipeline gave none). */
    phashes: bigint('phashes', { mode: 'bigint' }).array().notNull(),
    blockKeys: bigint('block_keys', { mode: 'bigint' }).array().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // candidate generation and the key-frequency cap (one `block_keys @> array[key]` probe a key). No pending list
    // (`fastupdate = off`): every probe would scan it, and the worker writes are small batches.
    index('dedupe_listing_signatures_keys_idx').using('gin', t.blockKeys).with({ fastupdate: false }),
    // the owner's signatures (backfill audits, agency erasure)
    index('dedupe_listing_signatures_owner_idx').on(t.ownerAgencyId, t.listingId),
    check('dedupe_listing_signatures_version_ck', sql`${t.sourceVersion} >= 1`),
    check(
      'dedupe_listing_signatures_images_ck',
      sql`cardinality(${t.imageKeys}) = cardinality(${t.phashes}) and cardinality(${t.imageKeys}) <= 32`,
    ),
    check('dedupe_listing_signatures_keys_ck', sql`cardinality(${t.blockKeys}) <= 256`),
  ],
);

/**
 * A scored candidate pair (R2-03a, PLAN §10): one row per unordered pair (`listing_a < listing_b`), with each signal's
 * 0–1 value (`signals`; null = not available, e.g. no embedding), the combined `score`, the scorer version and the two
 * signatures' source versions it was computed from. Pairs scoring below `PAIR_STORE_MIN` are not kept. Written by the
 * dedupe worker only; R2-03b clusters pairs ≥ 0.9 and queues 0.7–0.9 for review.
 */
export const dedupePairScores = pgTable(
  'dedupe_pair_scores',
  {
    listingA: uuid('listing_a').notNull(),
    listingB: uuid('listing_b').notNull(),
    agencyA: uuid('agency_a').notNull(),
    agencyB: uuid('agency_b').notNull(),
    score: real('score').notNull(),
    signals: jsonb('signals').$type<Record<string, number | null>>().notNull(),
    scorerVersion: smallint('scorer_version').notNull(),
    versionA: integer('version_a').notNull(),
    versionB: integer('version_b').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'dedupe_pair_scores_pk', columns: [t.listingA, t.listingB] }),
    // a listing's pairs from the other side (the PK covers listing_a)
    index('dedupe_pair_scores_b_idx').on(t.listingB),
    check('dedupe_pair_scores_order_ck', sql`${t.listingA} < ${t.listingB}`),
    check('dedupe_pair_scores_score_ck', sql`${t.score} >= 0 and ${t.score} <= 1`),
  ],
);

/**
 * R2-03b (PLAN §10, §3 #13): a duplicate cluster — listings of one property, one of them canonical (rank 0). Global and
 * worker-only (`noUserRead`; staff read it in the console): a cluster spans agencies. Written by the dedupe worker's
 * recluster pass only (`clusters.ts`), which keeps `size`, `canonical_listing_id` and the members' ranks in step.
 * `flagged`: the cluster reached `MAX_CLUSTER_MEMBERS` or its component was cut at `MAX_COMPONENT` (staff look).
 */
export const dedupeClusters = pgTable(
  'dedupe_clusters',
  {
    id: uuid('id').primaryKey(),
    canonicalListingId: uuid('canonical_listing_id').notNull(),
    size: smallint('size').notNull(),
    flagged: boolean('flagged').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('dedupe_clusters_size_ck', sql`${t.size} between 2 and 64`)],
);

/**
 * R2-03b: a listing's place in a cluster (a listing is in at most one). `rank` is the canonical order (0 = canonical:
 * a pinned listing, then the earliest listed, then the higher quality score, then the id); a client output shows the
 * first member it may show (R2-03c). `via`: `AUTO` (a pair ≥ 0.9 with the canonical) or `CONFIRMED` (a member
 * confirmed the pair in the review queue). Global, worker-only.
 */
export const dedupeClusterMembers = pgTable(
  'dedupe_cluster_members',
  {
    listingId: uuid('listing_id').primaryKey(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => dedupeClusters.id, { onDelete: 'cascade' }),
    /** The listing's owner. */
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    rank: smallint('rank').notNull(),
    via: text('via').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // a cluster's members in canonical order (the recluster pass's expansion, R2-03c's canonical pick)
    index('dedupe_cluster_members_cluster_idx').on(t.clusterId, t.rank),
    check('dedupe_cluster_members_via_ck', sql`${t.via} in ('AUTO', 'CONFIRMED')`),
    check('dedupe_cluster_members_rank_ck', sql`${t.rank} >= 0`),
  ],
);

/**
 * R2-03b: a decided pair (`listing_a < listing_b`). `NOT_DUPLICATE` is final: a rescore never clusters the pair again,
 * and no later confirmation replaces it. `CONFIRMED` (a member confirmed a review-queue pair) links the pair like an
 * auto-cluster score. `source`: the review queue or an upheld dispute. Global, worker-only (the review and dispute
 * rows members and staff write are applied here by the worker).
 */
export const dedupePairDecisions = pgTable(
  'dedupe_pair_decisions',
  {
    listingA: uuid('listing_a').notNull(),
    listingB: uuid('listing_b').notNull(),
    decision: text('decision').notNull(),
    source: text('source').notNull(),
    /** The agency whose review decided it; null for a staff dispute resolution. */
    decidedByAgencyId: uuid('decided_by_agency_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'dedupe_pair_decisions_pk', columns: [t.listingA, t.listingB] }),
    // a listing's decisions from the other side (the PK covers listing_a)
    index('dedupe_pair_decisions_b_idx').on(t.listingB),
    check('dedupe_pair_decisions_order_ck', sql`${t.listingA} < ${t.listingB}`),
    check('dedupe_pair_decisions_decision_ck', sql`${t.decision} in ('CONFIRMED', 'NOT_DUPLICATE')`),
    check('dedupe_pair_decisions_source_ck', sql`${t.source} in ('REVIEW', 'DISPUTE')`),
  ],
);

/** R2-03b: a listing staff made canonical of its cluster by upholding a `CANONICAL` dispute. Global, worker-only. */
export const dedupeCanonicalPins = pgTable('dedupe_canonical_pins', {
  listingId: uuid('listing_id').primaryKey(),
  disputeId: uuid('dispute_id').notNull(),
  pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * R2-03b: the agency's own clustered listings, as its members may read them (STRICT, read-only for members): the
 * cluster, the listing's rank, and the cluster's members in canonical order (`member_ids`, the listing itself
 * included). Written by the recluster pass in the transaction that changes the cluster. The service shows only the
 * members the caller may see (`search.offerableListingCards`, under the caller's RLS); the first of those is the
 * canonical as far as the agency's clients are concerned.
 */
export const dedupeListingClusters = pgTable(
  'dedupe_listing_clusters',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    listingId: uuid('listing_id').notNull(),
    clusterId: uuid('cluster_id').notNull(),
    rank: smallint('rank').notNull(),
    via: text('via').notNull(),
    memberIds: uuid('member_ids').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'dedupe_listing_clusters_pk', columns: [t.agencyId, t.listingId] }),
    // the recluster pass's writes by listing (worker)
    uniqueIndex('dedupe_listing_clusters_listing_uq').on(t.listingId),
    // the agency's clustered listings, newest first: where agency_id = ? order by created_at desc, listing_id desc
    index('dedupe_listing_clusters_page_idx').on(t.agencyId, t.createdAt, t.listingId),
    check('dedupe_listing_clusters_via_ck', sql`${t.via} in ('AUTO', 'CONFIRMED')`),
    check('dedupe_listing_clusters_members_ck', sql`cardinality(${t.memberIds}) between 2 and 64`),
  ],
);

/**
 * R2-03b, the review queue: a stored pair scoring 0.7–0.9 (or ≥ 0.9 but left out of a cluster), undecided, one row per
 * agency involved — `listing_id` its own listing, `other_listing_id` the other (another agency's, or its own: then one
 * row). Written by the recluster pass (`PENDING`); a member decides it (`CONFIRMED` / `NOT_DUPLICATE`, with who and
 * when), never inserts, deletes or changes its pair; the worker applies the decision (`dedupe.review.decided`). The
 * service shows a row only while the caller may see the other listing.
 */
export const dedupeReviews = pgTable(
  'dedupe_reviews',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    listingId: uuid('listing_id').notNull(),
    otherListingId: uuid('other_listing_id').notNull(),
    score: real('score').notNull(),
    signals: jsonb('signals').$type<Record<string, number | null>>().notNull(),
    status: text('status').notNull().default('PENDING'),
    decidedByUserId: uuid('decided_by_user_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one row per agency and pair
    uniqueIndex('dedupe_reviews_pair_uq').on(t.agencyId, t.listingId, t.otherListingId),
    // the agency's queue: where agency_id = ? and status = ? order by created_at desc, id desc
    index('dedupe_reviews_queue_idx').on(t.agencyId, t.status, t.createdAt, t.id),
    // the recluster pass's sync by listing, from either side (worker)
    index('dedupe_reviews_listing_idx').on(t.listingId),
    index('dedupe_reviews_other_idx').on(t.otherListingId),
    check('dedupe_reviews_status_ck', sql`${t.status} in ('PENDING', 'CONFIRMED', 'NOT_DUPLICATE')`),
    check(
      'dedupe_reviews_decided_ck',
      sql`(${t.status} = 'PENDING') = (${t.decidedByUserId} is null and ${t.decidedAt} is null)`,
    ),
    check('dedupe_reviews_score_ck', sql`${t.score} >= 0 and ${t.score} <= 1`),
    check('dedupe_reviews_self_ck', sql`${t.listingId} <> ${t.otherListingId}`),
  ],
);

/**
 * R2-03b, PLAN §10 "agencies can dispute": an agency disputes the clustering of its own listing — `NOT_DUPLICATE` (it
 * is not the same property as the others) or `CANONICAL` (it should be the canonical one, e.g. it holds the exclusive
 * mandate). The listing stays in its cluster while the dispute is `OPEN`; staff (data ops, super admins) uphold or
 * reject it with a note, audited (`staff.dedupe.disputeResolved`), and the worker applies an upheld one. A member
 * opens a dispute (its own row, `OPEN`), never changes or removes one; one open dispute per listing.
 */
export const dedupeDisputes = pgTable(
  'dedupe_disputes',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    listingId: uuid('listing_id').notNull(),
    clusterId: uuid('cluster_id').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('OPEN'),
    openedByUserId: uuid('opened_by_user_id').notNull(),
    resolvedByUserId: uuid('resolved_by_user_id'),
    resolutionNote: text('resolution_note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one open dispute per listing
    uniqueIndex('dedupe_disputes_open_uq').on(t.listingId).where(sql`${t.status} = 'OPEN'`),
    // the agency's disputes, newest first: where agency_id = ? order by created_at desc, id desc
    index('dedupe_disputes_agency_idx').on(t.agencyId, t.createdAt, t.id),
    // the staff queue by status, oldest first: where status = ? order by created_at, id
    index('dedupe_disputes_status_idx').on(t.status, t.createdAt, t.id),
    check('dedupe_disputes_kind_ck', sql`${t.kind} in ('NOT_DUPLICATE', 'CANONICAL')`),
    check('dedupe_disputes_status_ck', sql`${t.status} in ('OPEN', 'UPHELD', 'REJECTED')`),
    check('dedupe_disputes_reason_ck', sql`char_length(${t.reason}) between 1 and 1000`),
    check(
      'dedupe_disputes_resolved_ck',
      sql`(${t.status} = 'OPEN') = (${t.resolvedAt} is null and ${t.resolvedByUserId} is null)`,
    ),
    check(
      'dedupe_disputes_note_ck',
      sql`${t.resolutionNote} is null or char_length(${t.resolutionNote}) between 1 and 1000`,
    ),
  ],
);
