import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
