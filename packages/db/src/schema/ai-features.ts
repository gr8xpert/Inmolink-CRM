/**
 * Tables owned by the ai-features module (PATTERNS §2). Only `packages/core/src/modules/ai-features` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
