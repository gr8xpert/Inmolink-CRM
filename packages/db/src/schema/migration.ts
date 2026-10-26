/**
 * Tables owned by the migration module (PATTERNS §2). Only `packages/core/src/modules/migration` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { sql } from 'drizzle-orm';
import { char, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Every legacy ID and the v2 ID it became (PLAN §14, ADR 0006). Global and permanent: the legacy API shim
 * and redirects keep resolving old references after decommission. `entity` is the v2 entity kind
 * (`location`, `propertyType`, `feature`, later `listing`, `contact`, …); `legacy_id` is text because legacy
 * keys vary. Written by import scripts via `withSystem()`; re-runs upsert on (entity, legacy_id).
 */
export const legacyIdMaps = pgTable(
  'legacy_id_maps',
  {
    id: uuid('id').primaryKey(),
    entity: text('entity').notNull(),
    legacyId: text('legacy_id').notNull(),
    newId: uuid('new_id').notNull(),
    /** How the mapping was found (`exact`, `fuzzy`); informational. */
    method: text('method').notNull(),
    /**
     * S14-02: the v2 agency the mapped row belongs to (tenant entities: user, listing, contact, …); null for platform
     * reference data (taxonomy) and the agency maps. A load accepts a map only for its own agency and never re-points
     * another agency's (legacy ids are unique per legacy table; a collision is refused and reported).
     */
    targetAgencyId: uuid('target_agency_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // upsert target and legacy → new lookups
    uniqueIndex('legacy_id_maps_legacy_uq').on(t.entity, t.legacyId),
    // new → legacy lookups (redirects, delta sync)
    index('legacy_id_maps_new_idx').on(t.entity, t.newId),
  ],
);

/**
 * Checkpoints of the legacy load (S14-02, ADR 0006 "resume from the last checkpoint"): one row per agency, entity and
 * batch (its place in the staging order). A batch commits together with its row (`DONE`, counts and issues); a failed
 * one is recorded `FAILED` with the error and the run stops there, so a re-run skips the DONE batches whose staged
 * rows are unchanged (`input_hash`) and resumes at the failed one. Operator data written via `withSystem()` only.
 */
export const migrationBatches = pgTable(
  'migration_batches',
  {
    id: uuid('id').primaryKey(),
    legacyAgencyId: text('legacy_agency_id').notNull(),
    /** The v2 agency the legacy agency became (not `agency_id`: an operator table, not the agency's data). */
    targetAgencyId: uuid('target_agency_id').notNull(),
    /** The staged entity (`listings`, `contacts`, …). */
    entity: text('entity').notNull(),
    /** The batch's place in the staging order (0-based). */
    seq: integer('seq').notNull(),
    /** SHA-256 of the batch's staged rows: a changed staging file re-runs the batch. */
    inputHash: char('input_hash', { length: 64 }).notNull(),
    status: text('status').notNull(),
    rows: integer('rows').notNull(),
    /** What the batch did, per report entity (`LegacyLoadCounts` without the inventory fields). */
    counts: jsonb('counts').notNull().default(sql`'{}'::jsonb`),
    /** The rows it did not load, with reasons (`LegacyLoadReport.issues`, capped). */
    issues: jsonb('issues').notNull().default(sql`'[]'::jsonb`),
    /** Why a FAILED batch failed (the error's message, no data). */
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the checkpoint of a batch; an entity's batches in order (resume)
    uniqueIndex('migration_batches_batch_uq').on(t.legacyAgencyId, t.entity, t.seq),
    check('migration_batches_status_ck', sql`${t.status} in ('DONE', 'FAILED')`),
    check('migration_batches_seq_ck', sql`${t.seq} >= 0 and ${t.rows} >= 0 and ${t.attempts} >= 1`),
  ],
);
