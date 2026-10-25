/**
 * Tables owned by the presentations module (PATTERNS §2). Only `packages/core/src/modules/presentations` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Selections (S12-04, PLAN §7 M13): listings and units an agent picked for a client, shown on a branded live page in
 * `apps/public` (`/s/<token>`) — prices and status from the read models at view time, white-labelled, in the
 * client's language. The page is found by its token's keyed hash (`token_hash`, HMAC `HMAC_KEY`), never by id; the
 * token itself is never stored. STRICT (S13-F1): the public pages (`app_public`) read no row; the SECURITY DEFINER
 * `selection_by_token(hashes)` answers the live one (not revoked, not expired) a token names — who made it and for
 * which client never leave the agency.
 */
export const selections = pgTable(
  'selections',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The member who made it (no FK: a removed member's selections stay). Hidden from public reads. */
    createdBy: uuid('created_by').notNull(),
    /** The CRM contact it is for (no FK: crm's table); views, likes and enquiries reach their timeline. Hidden. */
    contactId: uuid('contact_id'),
    title: text('title').notNull(),
    /** The agent's note to the client, shown on the page (plain text, escaped when rendered). */
    message: text('message'),
    /** The client's language: the page's text and the documents' locale (with the agency's fallback). */
    locale: text('locale').notNull(),
    /** `hmacSha256(HMAC_KEY, 'presentations.selection-token', token)`. */
    tokenHash: text('token_hash').notNull(),
    /** The token's last 4 characters (the dashboard shows which link is live). */
    tokenHint: text('token_hint').notNull(),
    /** After this the page is gone (410); null: no expiry. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the public page: where token_hash = ? (the token's lookup)
    uniqueIndex('selections_token_uq').on(t.tokenHash),
    // the dashboard list: where agency_id = ? order by created_at desc, id desc (keyset); also the FK
    index('selections_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // a contact's selections: where agency_id = ? and contact_id = ?
    index('selections_contact_idx').on(t.agencyId, t.contactId).where(sql`${t.contactId} is not null`),
    // S13-F9, the interactions' retention: ended selections in (least(revoked_at, expires_at), id) order (keyset)
    index('selections_ended_idx')
      .on(sql`least(${t.revokedAt}, ${t.expiresAt})`, t.id)
      .where(sql`${t.revokedAt} is not null or ${t.expiresAt} is not null`),
    check('selections_title_ck', sql`length(${t.title}) between 1 and 200`),
    check('selections_message_ck', sql`${t.message} is null or length(${t.message}) between 1 and 2000`),
    check('selections_locale_ck', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('selections_version_ck', sql`${t.version} >= 1`),
  ],
);

/**
 * A selection's items, in the agent's order: a listing or a unit (its read model target), with the agent's own note
 * and title for it (escaped and white-labelled like the website serializer's overrides when rendered). STRICT: the
 * public pages read them only with their live selection, through `selection_by_token` (S13-F1).
 */
export const selectionItems = pgTable(
  'selection_items',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    selectionId: uuid('selection_id')
      .notNull()
      .references(() => selections.id, { onDelete: 'cascade' }),
    /** The listing's or unit's id (`listing_read_models.target_id`; no FK — another agency's listing may be one). */
    targetId: uuid('target_id').notNull(),
    position: integer('position').notNull(),
    /** The agent's title for the item (shown instead of the document's). */
    titleOverride: text('title_override'),
    /** The agent's note on the item. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the page and the dashboard: where selection_id = ? order by position; one row per target
    uniqueIndex('selection_items_position_uq').on(t.selectionId, t.position),
    uniqueIndex('selection_items_target_uq').on(t.selectionId, t.targetId),
    // FK (agency's rows)
    index('selection_items_agency_idx').on(t.agencyId),
    check('selection_items_position_ck', sql`${t.position} between 0 and 99`),
    check('selection_items_title_ck', sql`${t.titleOverride} is null or length(${t.titleOverride}) between 1 and 200`),
    check('selection_items_note_ck', sql`${t.note} is null or length(${t.note}) between 1 and 1000`),
  ],
);

/**
 * What the client did on the page (S12-04): a view, a like (or its undo) of an item, an enquiry about one. Written by
 * the public pages as `app_intake` (`withIntake`, pinned to the selection's agency) with the outbox event that puts it
 * on the CRM timeline; read back by the agency (the selection's dashboard view). STRICT.
 */
export const selectionInteractions = pgTable(
  'selection_interactions',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    selectionId: uuid('selection_id')
      .notNull()
      .references(() => selections.id, { onDelete: 'cascade' }),
    /** VIEW | LIKE | UNLIKE | ENQUIRE. */
    kind: text('kind').notNull(),
    /** The item's target (LIKE, UNLIKE; an ENQUIRE about one item); null for a view of the page. */
    targetId: uuid('target_id'),
    /** The client's enquiry (ENQUIRE only). Internal to the agency. */
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the selection's activity in the dashboard: where selection_id = ? order by created_at desc
    index('selection_interactions_selection_idx').on(t.selectionId, t.createdAt),
    // FK (agency's rows)
    index('selection_interactions_agency_idx').on(t.agencyId),
    check('selection_interactions_kind_ck', sql`${t.kind} in ('VIEW', 'LIKE', 'UNLIKE', 'ENQUIRE')`),
    check(
      'selection_interactions_target_ck',
      sql`(${t.kind} not in ('LIKE', 'UNLIKE') or ${t.targetId} is not null) and (${t.kind} <> 'VIEW' or ${t.targetId} is null) and (${t.kind} = 'ENQUIRE') = (${t.message} is not null)`,
    ),
    check('selection_interactions_message_ck', sql`${t.message} is null or length(${t.message}) between 1 and 2000`),
  ],
);
