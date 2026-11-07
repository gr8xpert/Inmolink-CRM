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
  uuid,
} from 'drizzle-orm/pg-core';

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
