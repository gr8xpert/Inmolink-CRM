/**
 * Tables owned by the imports module (PATTERNS §2, PLAN §7 M5). Only `packages/core/src/modules/imports` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * S6-01: a feed connection (one connector, one URL, encrypted credentials, schedule) produces feed runs; a run
 * keeps its counters and the first per-item errors. Child rows carry the connection's own `agency_id`, enforced
 * by composite foreign keys, so an agency cannot hang rows on another agency's connection or run.
 *
 * Per-connection mutex: at most one QUEUED or RUNNING run per connection (`feed_runs_connection_active_uq`). A
 * running run holds a lease (`lease_token`, `lease_until`): every write of the run's worker checks its token (a
 * fencing token), the worker renews the lease while it works, and a run whose lease lapsed (crashed worker) may be
 * claimed again — by its own retry — or is failed by the scheduler after a grace period, freeing the slot.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

export const feedRunStateEnum = pgEnum('feed_run_state', ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']);
export const feedRunTriggerEnum = pgEnum('feed_run_trigger', ['SCHEDULE', 'MANUAL']);

/**
 * A connector's field mapping kept by the agency (generic XML visual mapper, S6-04+). Schemaless per connector,
 * validated by the connector that reads it.
 */
export const feedMappingProfiles = pgTable(
  'feed_mapping_profiles',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    name: text('name').notNull(),
    connector: text('connector').notNull(),
    mapping: jsonb('mapping').notNull().default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('feed_mapping_profiles_id_agency_uq').on(t.id, t.agencyId),
    // FK + the agency's profiles, newest first
    index('feed_mapping_profiles_agency_created_idx').on(t.agencyId, t.createdAt),
    check('feed_mapping_profiles_name_ck', sql`char_length(${t.name}) between 1 and 120`),
    check('feed_mapping_profiles_connector_ck', sql`${t.connector} ~ '^[a-z][a-z0-9-]{1,31}$'`),
  ],
);

export const feedConnections = pgTable(
  'feed_connections',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    name: text('name').notNull(),
    /** Connector key in the code registry (`kyero`, `generic-xml`, …). */
    connector: text('connector').notNull(),
    /** http(s) only; fetched through `safeFetch` (checked again on every fetch and redirect). */
    url: text('url').notNull(),
    /** `platform/crypto` envelope of the JSON credentials, bound to (agency, table, column, row). Never returned. */
    credentialsEnc: text('credentials_enc'),
    /** Connector options (record element, language, …), validated by the connector. */
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    mappingProfileId: uuid('mapping_profile_id'),
    enabled: boolean('enabled').notNull().default(true),
    /** Minutes between scheduled runs; null = manual only. */
    scheduleMinutes: integer('schedule_minutes'),
    /** When the scheduler next starts a run (null: manual only or disabled). */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunState: feedRunStateEnum('last_run_state'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('feed_connections_id_agency_uq').on(t.id, t.agencyId),
    // the agency's connections list: where agency_id = ? order by created_at desc, id desc
    index('feed_connections_agency_created_idx').on(
      t.agencyId,
      sql`date_trunc('milliseconds', ${t.createdAt}, 'UTC')`,
      t.id,
    ),
    // scheduler: enabled connections due now, oldest first
    index('feed_connections_due_idx').on(t.nextRunAt).where(sql`${t.enabled} and ${t.nextRunAt} is not null`),
    // FK to the mapping profile
    index('feed_connections_mapping_profile_idx').on(t.mappingProfileId).where(sql`${t.mappingProfileId} is not null`),
    foreignKey({
      name: 'feed_connections_mapping_profile_fk',
      columns: [t.mappingProfileId, t.agencyId],
      foreignColumns: [feedMappingProfiles.id, feedMappingProfiles.agencyId],
    }),
    check('feed_connections_name_ck', sql`char_length(${t.name}) between 1 and 120`),
    check('feed_connections_connector_ck', sql`${t.connector} ~ '^[a-z][a-z0-9-]{1,31}$'`),
    check('feed_connections_url_ck', sql`${t.url} ~ '^https?://' and char_length(${t.url}) <= 2048`),
    check(
      'feed_connections_schedule_ck',
      sql`${t.scheduleMinutes} is null or ${t.scheduleMinutes} between 15 and 10080`,
    ),
  ],
);

export const feedRuns = pgTable(
  'feed_runs',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    connectionId: uuid('connection_id').notNull(),
    trigger: feedRunTriggerEnum('trigger').notNull(),
    /** The member who asked for a manual run. */
    requestedByUserId: uuid('requested_by_user_id'),
    state: feedRunStateEnum('state').notNull().default('QUEUED'),
    /** Claims so far (a crashed worker's retry claims again and starts over). */
    attempt: integer('attempt').notNull().default(0),
    /** Fencing token of the worker holding the run; every write of the run checks it. */
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    itemsTotal: integer('items_total').notNull().default(0),
    itemsValid: integer('items_valid').notNull().default(0),
    itemsFailed: integer('items_failed').notNull().default(0),
    itemsCreated: integer('items_created').notNull().default(0),
    itemsUpdated: integer('items_updated').notNull().default(0),
    itemsUnchanged: integer('items_unchanged').notNull().default(0),
    /** `feed_item_errors` rows kept for this run (capped; `items_failed` counts all). */
    errorsLogged: integer('errors_logged').notNull().default(0),
    bytesRead: bigint('bytes_read', { mode: 'number' }).notNull().default(0),
    /** Why the run failed as a whole (an imports error code). */
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('feed_runs_id_agency_uq').on(t.id, t.agencyId),
    foreignKey({
      name: 'feed_runs_connection_fk',
      columns: [t.connectionId, t.agencyId],
      foreignColumns: [feedConnections.id, feedConnections.agencyId],
    }).onDelete('cascade'),
    // the per-connection mutex: one waiting or running run per connection
    uniqueIndex('feed_runs_connection_active_uq').on(t.connectionId).where(sql`${t.state} in ('QUEUED', 'RUNNING')`),
    // FK + a connection's run history: where connection_id = ? order by created_at desc, id desc
    index('feed_runs_connection_created_idx').on(
      t.connectionId,
      sql`date_trunc('milliseconds', ${t.createdAt}, 'UTC')`,
      t.id,
    ),
    // FK (agency_id)
    index('feed_runs_agency_created_idx').on(t.agencyId, t.createdAt),
    // retention prune (`imports.pruneRuns`): finished runs older than the cut-off, oldest first
    index('feed_runs_finished_created_idx').on(t.createdAt).where(sql`${t.state} in ('SUCCEEDED', 'FAILED')`),
    // scheduler: active runs whose lease lapsed or that never started
    index('feed_runs_active_idx')
      .on(t.state, t.leaseUntil, t.createdAt)
      .where(sql`${t.state} in ('QUEUED', 'RUNNING')`),
    check(
      'feed_runs_counts_ck',
      sql`${t.itemsValid} + ${t.itemsFailed} = ${t.itemsTotal}
        and ${t.itemsCreated} + ${t.itemsUpdated} + ${t.itemsUnchanged} <= ${t.itemsValid}
        and ${t.errorsLogged} <= ${t.itemsFailed}`,
    ),
    check('feed_runs_lease_ck', sql`(${t.state} = 'RUNNING') = (${t.leaseToken} is not null)`),
  ],
);

/** One item of a run that could not be mapped or failed validation (the first `FEED_ERRORS_KEPT` per run). */
export const feedItemErrors = pgTable(
  'feed_item_errors',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    runId: uuid('run_id').notNull(),
    /** 0-based position of the record in the feed. */
    position: integer('position').notNull(),
    /** The item's reference in the feed, when it had one. */
    itemRef: text('item_ref'),
    code: text('code').notNull(),
    field: text('field'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'feed_item_errors_run_fk',
      columns: [t.runId, t.agencyId],
      foreignColumns: [feedRuns.id, feedRuns.agencyId],
    }).onDelete('cascade'),
    // FK + a run's errors in feed order: where run_id = ? order by position, id
    index('feed_item_errors_run_position_idx').on(t.runId, t.position, t.id),
    check('feed_item_errors_ref_ck', sql`char_length(${t.itemRef}) <= 200`),
    check('feed_item_errors_code_ck', sql`${t.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
    check('feed_item_errors_field_ck', sql`char_length(${t.field}) <= 120`),
    check('feed_item_errors_message_ck', sql`char_length(${t.message}) <= 500`),
  ],
);
