/**
 * Tables owned by the ai-features module (PATTERNS §2). Only `packages/core/src/modules/ai-features` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * S12-02: a bulk Listing Studio request sent to the provider's batch API. The collect job must hand the gateway the
 * very items it submitted (S12-01 review: a batch is matched by the hash of its items), so they are kept here — the
 * model inputs (facts, names, the agency's source text; never a price, commission or private field) — with the facts
 * hash of each listing at submit time: a draft for facts that changed meanwhile is dropped (STALE). `id` is the
 * request id (the outbox event's); `state` RUNNING until the answers are applied (DONE) or the batch is given up.
 * Rows are pruned `STUDIO_BATCH_RETENTION_DAYS` after they were created (ai-features maintenance job): a batch ends
 * within a day.
 */
export const listingStudioBatches = pgTable(
  'listing_studio_batches',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The member who asked; the jobs act as them (role and listing access re-read at write time). */
    createdByUserId: uuid('created_by_user_id').notNull(),
    /** The listings, by position (custom ids are `l<position>_<locale>`). */
    listingIds: uuid('listing_ids').array().notNull(),
    locales: text('locales').array().notNull(),
    tone: text('tone').notNull(),
    replaceReviewed: boolean('replace_reviewed').notNull().default(false),
    /** Facts hash per listing position at submit time (16 hex characters; '' when the listing was not editable). */
    factsHashes: text('facts_hashes').array().notNull(),
    /** The submitted batch items `[{ customId, input }]`, exactly as sent. */
    items: jsonb('items').notNull(),
    /** Null until the provider accepted the batch (a retried submit job sends it again). */
    providerBatchId: text('provider_batch_id'),
    state: text('state').notNull().default('RUNNING'),
    written: integer('written').notNull().default(0),
    dropped: integer('dropped').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // FK + the agency's recent batches
    index('listing_studio_batches_agency_created_idx').on(t.agencyId, t.createdAt),
    // the prune (all agencies): batches older than the retention, oldest first
    index('listing_studio_batches_created_idx').on(t.createdAt),
    check('listing_studio_batches_state_ck', sql`${t.state} in ('RUNNING', 'DONE', 'GAVE_UP')`),
    check(
      'listing_studio_batches_sizes_ck',
      sql`cardinality(${t.listingIds}) between 1 and 100 and cardinality(${t.factsHashes}) = cardinality(${t.listingIds})
        and cardinality(${t.locales}) between 1 and 20`,
    ),
  ],
);

/**
 * S13-F21: listings an agency asked Listing Studio to draft, per calendar month (UTC) — the plan quota
 * `studio_listings_month` (PLAN §11: Free 10 a month). Counted when a request is accepted (single or bulk), in the
 * request's transaction under the agency's studio lock; read only there (the primary key). Kept: a few rows a year.
 */
export const listingStudioUsage = pgTable(
  'listing_studio_usage',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /** The first day of the month (UTC). */
    month: date('month', { mode: 'string' }).notNull(),
    listings: integer('listings').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the quota check and the increment: where agency_id = ? and month = ?
    primaryKey({ columns: [t.agencyId, t.month] }),
    check('listing_studio_usage_listings_ck', sql`${t.listings} >= 0`),
  ],
);

/**
 * S13-F25: one page of the white-label backfill walk sent to the provider's batch API (half price) — submitted by
 * `aiFeatures.whiteLabelBackfill`, answered by `aiFeatures.collectWhiteLabelBatch` up to a day later. The collect job
 * must hand the gateway the very items it submitted (a batch is matched by the hash of its items), so they are kept
 * here, not in the job payload (≤ 10 KB): per network-shown document of the page `{ customId, targetId, version,
 * texts: [{ key, sent }] }` (the deterministic pass's output only, never an identity or contact), plus `spans` for an
 * item the response cache answered at submit. `page_key` is the backfill job's id — the batch's idempotency key (a
 * retried submit never sends the page twice); `cursor` where the walk's next page starts (null: the last page).
 * `state` RUNNING until the answers are applied (DONE) or the batch is given up (GAVE_UP). Worker-only (`withSystem`);
 * pruned with the Listing Studio batches (`STUDIO_BATCH_RETENTION_DAYS` after they were created).
 */
export const whiteLabelBatches = pgTable(
  'white_label_batches',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    pageKey: text('page_key').notNull(),
    items: jsonb('items').notNull(),
    cursor: jsonb('cursor'),
    /** Null until the provider accepted the batch (or every item came from the response cache). */
    providerBatchId: text('provider_batch_id'),
    state: text('state').notNull().default('RUNNING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the retried submit / the collect job: where agency_id = ? and page_key = ? (also the FK index)
    uniqueIndex('white_label_batches_page_uq').on(t.agencyId, t.pageKey),
    // the prune (all agencies): batches older than the retention, oldest first
    index('white_label_batches_created_idx').on(t.createdAt),
    check('white_label_batches_state_ck', sql`${t.state} in ('RUNNING', 'DONE', 'GAVE_UP')`),
    check('white_label_batches_page_key_ck', sql`length(${t.pageKey}) between 1 and 128`),
  ],
);
