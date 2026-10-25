/**
 * Tables owned by the admin module (PATTERNS §2). Only `packages/core/src/modules/admin` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * S13-03: a staff bulk operation (reindex, rebuild read models, re-import, replay outbox) — one agency's or every
 * agency's. Staff start and cancel it (`app_staff`, registry `staffWrite`); the `admin.runStaffOperation` job
 * (`app_system`) advances it a step at a time, saving `cursor` and `done` after each, so a retried job resumes and the
 * console shows progress. Platform data: no `agency_id` (the scope is `target_agency_id`, null for every agency).
 */
export const staffOperations = pgTable(
  'staff_operations',
  {
    id: uuid('id').primaryKey(),
    /** REINDEX | REBUILD_READ_MODELS | REIMPORT | REPLAY_OUTBOX */
    kind: text('kind').notNull(),
    /** The agency the operation is scoped to; null: every agency. */
    targetAgencyId: uuid('target_agency_id'),
    /** REPLAY_OUTBOX: `{ since, until, type, deadOnly }`. */
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    /** QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED */
    state: text('state').notNull().default('QUEUED'),
    /** Where the next step starts (the last agency id, the last outbox event id); null: from the beginning. */
    cursor: text('cursor'),
    done: integer('done').notNull().default(0),
    total: integer('total'),
    /** Continuation jobs queued so far (each job ID is `<id>:<slice>`, so none collides with an earlier one). */
    slices: integer('slices').notNull().default(0),
    /** Times the sweep re-queued it after its job was lost; past the limit it ends FAILED (`STALLED`). */
    recoveries: integer('recoveries').notNull().default(0),
    /** Why staff ran it (support ticket, what broke): kept for staff, never in the audit log. */
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the console's list: order by created_at desc, id desc (optionally where state = ?)
    index('staff_operations_created_idx').on(t.createdAt, t.id),
    // admin.sweepStaffOperations: active operations whose job stopped moving (where state in (…) and updated_at < ?)
    index('staff_operations_active_idx').on(t.updatedAt).where(sql`${t.state} in ('QUEUED', 'RUNNING')`),
    // one active operation per kind and scope (a second start is STAFF_OPERATION_ACTIVE)
    uniqueIndex('staff_operations_active_uq')
      .on(t.kind, sql`coalesce(${t.targetAgencyId}, ${sql.raw(`'${PLATFORM_AGENCY_ID}'`)}::uuid)`)
      .where(sql`${t.state} in ('QUEUED', 'RUNNING')`),
    check(
      'staff_operations_kind_ck',
      sql`${t.kind} in ('REINDEX', 'REBUILD_READ_MODELS', 'REIMPORT', 'REPLAY_OUTBOX')`,
    ),
    check('staff_operations_state_ck', sql`${t.state} in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')`),
    check('staff_operations_done_ck', sql`${t.done} >= 0`),
  ],
);
