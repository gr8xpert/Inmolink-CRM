import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Feature flags (PLAN §3 #42): risky features ship dark → pilot agencies → everyone. Staff-managed
 * platform config, so a global table: readable by `app_user`, written only through `withSystem()`.
 * Agencies cannot switch their own flags on. Read and cached by `@inmolink/platform/flags`; keep
 * column names in sync.
 *
 * Per-agency overrides are agency ID lists on the flag row (one query loads every flag for every
 * tenant). `disabled_for` wins over `enabled_for`, which wins over `enabled`.
 */
export const featureFlags = pgTable('feature_flags', {
  /** `area.feature` — lowercase, digits, `.`, `_`, `-`. */
  key: text('key').primaryKey(),
  description: text('description').notNull().default(''),
  /** Default for every agency without an override. */
  enabled: boolean('enabled').notNull().default(false),
  enabledFor: uuid('enabled_for').array().notNull().default(sql`'{}'::uuid[]`),
  disabledFor: uuid('disabled_for').array().notNull().default(sql`'{}'::uuid[]`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
