/**
 * Tables owned by the quality module (PATTERNS §2). Only `packages/core/src/modules/quality` imports this file
 * (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { index, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Quality recompute queue (S6-F3, the S5-F4 `read_model_queue` shape): listings whose quality score must be computed
 * again, written by the quality subscriptions (one row per listing, however many events — an import emits one per
 * row) and drained by `quality.recomputeListings` in batches of `QUALITY_BATCH` per transaction, per agency (fair
 * share). Worker-only (`withSystem`), no tenant access; the scores themselves are computed in the owner agency's
 * tenant transaction.
 */
export const qualityQueue = pgTable(
  'quality_queue',
  {
    listingId: uuid('listing_id').primaryKey(),
    /** The listing's agency: the recompute job's fair-share group and tenant (not an access boundary: worker-only). */
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    /** Bumped by every change queued again: a recompute that claimed an older generation leaves the row queued. */
    generation: integer('generation').notNull().default(1),
    /** Debounce: a burst of changes to one listing is scored once, after its last change settled. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull().defaultNow(),
    /** Photos still processing: recomputes left (a recheck pushes `due_at` a minute on). A change resets it. */
    rechecks: integer('rechecks').notNull().default(0),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    claimToken: uuid('claim_token'),
  },
  (t) => [
    // claim: an agency's due listings, oldest first
    index('quality_queue_agency_due_idx').on(t.ownerAgencyId, t.dueAt),
    // the sweep: overdue rows of any agency (S6-F3 review: no whole-queue scan every minute)
    index('quality_queue_due_idx').on(t.dueAt),
  ],
);
