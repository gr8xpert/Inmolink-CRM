import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
 * Tables owned by the compliance module (PATTERNS §2). Only `packages/core/src/modules/compliance` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

/**
 * PARTITIONED (`PARTITION BY RANGE (occurred_at)`, hand-added to migration 0023; pg_partman setup and the
 * immutability triggers in 0024): the primary key and every unique index must include `occurred_at`.
 *
 * Audit log (S1-08, PLAN §6 Support/audit, §12): security-relevant actions, one row each, written by
 * `compliance.audit*()` in the transaction of the change. Append-only — no app role has UPDATE or DELETE
 * (registry `immutable`). Range-partitioned by month on `occurred_at` (pg_partman, migration 0024); the
 * primary key includes the partition column. Platform rows (staff without an agency, users without a
 * membership) use the nil agency id, like platform outbox events. No foreign keys: rows outlive the
 * users, keys and agencies they name.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    agencyId: uuid('agency_id').notNull(),
    /** `<module>.<entity>.<change>`, e.g. `identity.login.failed` (core `AUDIT_TYPES`). */
    type: text('type').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: uuid('actor_user_id'),
    /** The staff member acting as `actor_user_id` (impersonation, S1-09). */
    impersonatedBy: uuid('impersonated_by'),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    requestId: text('request_id'),
    /** Small, non-secret details (ids, field names, outcomes). Never passwords, tokens, keys or free text. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    // the agency's audit log: where agency_id = ? order by occurred_at desc, id desc (keyset; scanned backwards)
    index('audit_logs_agency_idx').on(t.agencyId, t.occurredAt, t.id),
    // history of one user / key / request (staff viewer, S1-09): where target_id = ? order by occurred_at desc
    index('audit_logs_target_idx').on(t.targetId, t.occurredAt).where(sql`${t.targetId} is not null`),
    // staff viewer (S1-09), every agency: order by occurred_at desc, id desc (keyset; scanned backwards)
    index('audit_logs_time_idx').on(t.occurredAt, t.id),
    // staff viewer (S1-09), one type: where type = ? order by occurred_at desc, id desc
    index('audit_logs_type_idx').on(t.type, t.occurredAt, t.id),
    check('audit_logs_type_ck', sql`${t.type} ~ '^[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*){1,4}$'`),
    check('audit_logs_actor_kind_ck', sql`${t.actorKind} in ('user', 'staff', 'system', 'apiKey', 'anonymous')`),
    check('audit_logs_target_ck', sql`(${t.targetType} is null) = (${t.targetId} is null)`),
    check('audit_logs_target_type_ck', sql`${t.targetType} is null or ${t.targetType} ~ '^[a-z][a-zA-Z0-9]{0,39}$'`),
    check('audit_logs_request_id_ck', sql`${t.requestId} is null or length(${t.requestId}) <= 128`),
    check(
      'audit_logs_metadata_ck',
      sql`jsonb_typeof(${t.metadata}) = 'object' and octet_length(${t.metadata}::text) <= 4096`,
    ),
  ],
);

/**
 * Data export (S10-08, PLAN §3 #59 "you can always leave"): an agency's contacts, leads or listings as CSV / XLSX, or
 * the whole account as a ZIP (those tables plus a media manifest). Requested by an admin (`QUEUED`), written by the
 * `compliance.runDataExport` worker job straight into the private bucket (`data-exports/<agency>/<id>`), downloaded
 * through short signed links until `expires_at` (7 days after it finished); the daily sweep then deletes the file
 * and marks the row `EXPIRED`. The row holds counts and codes only — never the exported data.
 */
export const dataExportJobs = pgTable(
  'data_export_jobs',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The admin who asked (no FK: a removed member's exports stay until they expire). */
    createdBy: uuid('created_by').notNull(),
    /** `CONTACTS`, `LEADS`, `LISTINGS` or `ACCOUNT` (the ZIP of all of them plus the media manifest). */
    kind: text('kind').notNull(),
    /** `csv` or `xlsx` (for `ACCOUNT`: the format of the tables inside the ZIP). */
    format: text('format').notNull(),
    /** `QUEUED` → `RUNNING` → `SUCCEEDED` | `FAILED`; `EXPIRED` once the file is deleted after `expires_at`. */
    status: text('status').notNull().default('QUEUED'),
    /** Rows written per table (`{ contacts, leads, listings, media }`). */
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    fileBytes: bigint('file_bytes', { mode: 'number' }),
    /** Why the run failed (an error code, never a message with data). */
    errorCode: text('error_code'),
    /** Claims so far: a run's outcome is written only by the attempt that holds the latest claim. */
    attempts: integer('attempts').notNull().default(0),
    /** SHA-256 of the requesting admin's `Idempotency-Key` (with their user id): a retried `POST` within 24 h replays. */
    idempotencyHash: text('idempotency_hash'),
    /** SHA-256 of that request's body: the same key with another body is refused, not replayed. */
    requestHash: text('request_hash'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** When the download stops working and the sweep deletes the file (finished + 7 days). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** When the file was deleted from storage (sweep); null while it may still be there. */
    fileDeletedAt: timestamp('file_deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the agency's exports, newest first: where agency_id = ? order by date_trunc(created_at) desc, id desc (keyset)
    // S12-F20: raw keyset (`keysetAfterRaw`): the cursor is an index condition under RLS
    index('data_export_jobs_agency_created_raw_idx').on(t.agencyId, t.createdAt, t.id),
    // one export at a time per agency: where agency_id = ? and status in ('QUEUED', 'RUNNING')
    uniqueIndex('data_export_jobs_active_uq').on(t.agencyId).where(sql`${t.status} in ('QUEUED', 'RUNNING')`),
    // POST replay: where agency_id = ? and idempotency_hash = ?
    uniqueIndex('data_export_jobs_idempotency_uq')
      .on(t.agencyId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
    // daily sweep: files past their expiry (where file_deleted_at is null and expires_at < ?), and runs stuck
    // queued or running (where status in ('QUEUED', 'RUNNING') and created_at < ?)
    index('data_export_jobs_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.fileDeletedAt} is null and ${t.expiresAt} is not null`),
    index('data_export_jobs_stuck_idx').on(t.createdAt).where(sql`${t.status} in ('QUEUED', 'RUNNING')`),
    check('data_export_jobs_kind_ck', sql`${t.kind} in ('CONTACTS', 'LEADS', 'LISTINGS', 'ACCOUNT')`),
    check('data_export_jobs_format_ck', sql`${t.format} in ('csv', 'xlsx')`),
    check('data_export_jobs_status_ck', sql`${t.status} in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')`),
    check('data_export_jobs_error_ck', sql`${t.errorCode} is null or length(${t.errorCode}) <= 64`),
    check('data_export_jobs_idempotency_ck', sql`(${t.idempotencyHash} is null) = (${t.requestHash} is null)`),
    check('data_export_jobs_counts_ck', sql`jsonb_typeof(${t.counts}) = 'object'`),
  ],
);
