import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Transactional outbox (PLAN §5.3 #6, PATTERNS §8). Written by `emit()` in the caller's
 * transaction (as `app_user`, RLS: own agency only), read and acknowledged by the dispatcher
 * (`withSystem`). SQL lives in `@inmolink/platform/outbox`; keep column names in sync.
 *
 * Platform-wide events (no tenant) use the nil UUID as `agency_id` and can only be emitted
 * through `withSystem()`.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    /** UUIDv7 — time-ordered, so `order by id` is emit order within a batch. */
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    type: text('type').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Next time the dispatcher may claim the row: lease expiry while delivering, backoff after a failure. */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    /** Delivery attempts started (incremented on claim). */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Set when every subscriber succeeded — or with `dead_at` when attempts ran out. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    /** W3C `traceparent` of the emitting span: the dispatcher's delivery span continues that trace (S0-10). */
    traceParent: text('trace_parent'),
  },
  (t) => [
    // dispatcher claim (S1-F2, per-tenant fair share): a loose index scan enumerates the agencies with
    // due rows (`agency_id > ? and available_at <= now() order by agency_id limit 1`, one probe each), then
    // takes each agency's oldest due rows (`agency_id = ? and available_at <= now() order by available_at, id`).
    index('outbox_events_pending_idx').on(t.agencyId, t.availableAt, t.id).where(sql`${t.processedAt} is null`),
    // retention prune: where processed_at < now() - interval
    index('outbox_events_processed_idx').on(t.processedAt).where(sql`${t.processedAt} is not null`),
    // replay by type and time window (ops script)
    index('outbox_events_type_created_idx').on(t.type, t.createdAt),
    // Only a well-formed W3C traceparent (or none) — the dispatcher continues the trace it names.
    check(
      'outbox_events_trace_parent_format',
      sql`${t.traceParent} is null or ${t.traceParent} ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'`,
    ),
  ],
);
