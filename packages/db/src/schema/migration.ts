/**
 * Tables owned by the migration module (PATTERNS §2). Only `packages/core/src/modules/migration` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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

/**
 * Legacy URL → v2 URL (S14-05, PLAN §14 step 8): a URL that existed on inmolink.es or in a plugin-built page answers
 * 301 to its v2 equivalent, never 404. Platform data (the legacy portal and plugins are not per agency), written by
 * the migration scripts via `withSystem()`, read by the portal and the plugin shim (`app_public`) on the request path
 * through the unique `(source, locale, path_key)` index, one row per probe. `target_path` is the finished v2 path
 * (locale prefix included), built by the URL helpers when the row is written; `entity`/`target_id` say what it names so
 * a changed slug can rebuild it. `hits`/`last_hit_at` are bumped in batches by the flush job, never per request.
 */
export const legacyUrlRedirects = pgTable(
  'legacy_url_redirects',
  {
    id: uuid('id').primaryKey(),
    /** Where the legacy URL lived: the legacy portal or a plugin-built page. */
    source: text('source').notNull(),
    /** The legacy URL's locale (the 9 locales); '' for a URL without one. */
    locale: text('locale').notNull().default(''),
    /** The normalized legacy path (+ the query keys that identify a page); see `normalizeLegacyUrl`. */
    pathKey: text('path_key').notNull(),
    /** The v2 path to redirect to (starts with '/'). */
    targetPath: text('target_path').notNull(),
    /** What the target is (`listing`, `development`, `location`, `page`), informational. */
    entity: text('entity').notNull(),
    targetId: uuid('target_id'),
    status: integer('status').notNull().default(301),
    hits: bigint('hits', { mode: 'number' }).notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the resolver: where source = $1 and locale = $2 and path_key = $3 (one probe per request, cached in-process)
    uniqueIndex('legacy_url_redirects_key_uq').on(t.source, t.locale, t.pathKey),
    // rebuilding the targets of one entity when its slug changes
    index('legacy_url_redirects_target_idx').on(t.entity, t.targetId),
    check('legacy_url_redirects_source_ck', sql`${t.source} in ('portal', 'plugin')`),
    check('legacy_url_redirects_status_ck', sql`${t.status} in (301, 308)`),
    check('legacy_url_redirects_target_ck', sql`${t.targetPath} like '/%' and ${t.targetPath} not like '//%'`),
  ],
);

/**
 * Validation reports of the legacy migration (S14-03, PLAN §14 Path A step 6): one row per legacy agency and run of
 * `pnpm legacy:validate` — counts per entity, image counts, sampled field diffs, URL checks and PASS / FAIL against the
 * < 0.5 % target. `report` is the run's snapshot (`MigrationValidationReport`: ids, counts and field names, never
 * personal values). `latest` marks each legacy agency's newest report (the console's list); older ones stay as history.
 * Written by the validation script via `withSystem()`; staff read them in the console.
 */
export const migrationValidationReports = pgTable(
  'migration_validation_reports',
  {
    id: uuid('id').primaryKey(),
    legacyAgencyId: text('legacy_agency_id').notNull(),
    /** The v2 agency the legacy agency became (an operator table: not `agency_id`). */
    targetAgencyId: uuid('target_agency_id').notNull(),
    status: text('status').notNull(),
    latest: boolean('latest').notNull().default(true),
    /** Legacy rows and images compared, and the differences without a reason among them. */
    legacyRows: integer('legacy_rows').notNull(),
    unexplained: integer('unexplained').notNull(),
    sampleDiffs: integer('sample_diffs').notNull(),
    urlFailures: integer('url_failures').notNull(),
    report: jsonb('report').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one latest report per legacy agency (a new run replaces it)
    uniqueIndex('migration_validation_reports_latest_uq').on(t.legacyAgencyId).where(sql`${t.latest}`),
    // the console's list: latest reports newest first, optionally one status
    index('migration_validation_reports_list_idx').on(t.status, t.createdAt, t.id).where(sql`${t.latest}`),
    index('migration_validation_reports_created_idx').on(t.createdAt, t.id).where(sql`${t.latest}`),
    check('migration_validation_reports_status_ck', sql`${t.status} in ('PASS', 'FAIL')`),
    check(
      'migration_validation_reports_counts_ck',
      sql`${t.legacyRows} >= 0 and ${t.unexplained} >= 0 and ${t.sampleDiffs} >= 0 and ${t.urlFailures} >= 0`,
    ),
  ],
);
