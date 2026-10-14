/**
 * Tables owned by the migration module (PATTERNS §2). Only `packages/core/src/modules/migration` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
