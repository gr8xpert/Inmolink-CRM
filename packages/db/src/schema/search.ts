/**
 * Tables owned by the search module (PATTERNS §2, §14). Only `packages/core/src/modules/search` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * Read models (S5-01, PLAN §5.3 #3): one precomputed document pair per listing or new-build unit and content
 * locale, so feed-api, portal and search hydration read by primary key instead of joining raw tables. Written
 * only by the search worker (`withSystem`) from outbox events; never by request handlers. They hold only
 * client-safe fields (no owner, commission or private data); white-labelling is applied per site when served.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/** LISTING: a `properties` row · UNIT: a new-build `units` row (its development's text and place). */
export const readModelKindEnum = pgEnum('read_model_kind', ['LISTING', 'UNIT']);

export const listingReadModels = pgTable(
  'listing_read_models',
  {
    /** The listing's or unit's id (UUIDv7: unique across both tables). */
    targetId: uuid('target_id').notNull(),
    locale: text('locale').notNull(),
    kind: readModelKindEnum('kind').notNull(),
    /** The owner agency: routing and filters only, never inside the documents (white-labelling, PLAN §3 #6). */
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The unit's development, or the listing's when it belongs to one. */
    developmentId: uuid('development_id'),
    /**
     * `app_public` (feed-api, portal) may read the row: a PUBLIC listing, or a unit of an OPEN development.
     * SHARED listings and PRIVATE_NETWORK units are built too (network search hydration, S5-02) but stay
     * unreadable to public paths.
     */
    public: boolean('public').notNull(),
    /** The listing's or unit's status (ACTIVE, SOLD, AVAILABLE, …): public paths filter on it. */
    status: text('status').notNull(),
    /**
     * Monotonic source version: the listing's `version`, or a unit's `version` + its development's `version`
     * (both only grow). An upsert never lowers it (PATTERNS §14).
     */
    version: integer('version').notNull(),
    /** Small JSON for lists and search results (`ListingCardDoc` / `UnitCardDoc`). */
    card: jsonb('card').notNull(),
    /** Full JSON for detail pages (`ListingDetailDoc` / `UnitDetailDoc`). */
    detail: jsonb('detail').notNull(),
    /** Hash of card + detail: feed-api's ETag. */
    etag: text('etag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // feed-api / portal / search hydration: a document by (target, locale)
    primaryKey({ columns: [t.targetId, t.locale], name: 'listing_read_models_pk' }),
    // FK + an agency's rebuild (`--agency`, a locale change): its rows of a kind between two of its live targets
    index('listing_read_models_agency_idx').on(t.agencyId, t.kind, t.targetId),
    // a development's change: the read models of its units (and listings) that may no longer have one
    index('listing_read_models_development_idx').on(t.developmentId).where(sql`${t.developmentId} is not null`),
    check('listing_read_models_version_ck', sql`${t.version} >= 1`),
  ],
);
