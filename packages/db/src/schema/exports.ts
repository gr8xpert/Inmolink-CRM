/**
 * Tables owned by the exports module (PATTERNS §2, PLAN §7 M7). Only `packages/core/src/modules/exports` imports
 * this file (`pnpm check:boundaries`).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';
import { properties } from './properties';

/** AVAILABLE: agencies can connect it · PLANNED: listed, waiting for the portal's partner approval (PLAN §3 #19). */
export const portalChannelStatusEnum = pgEnum('portal_channel_status', ['AVAILABLE', 'PLANNED']);
/** Which of the agency's listings a connection sends: every PUBLIC one · the ones carrying a tag · only the chosen. */
export const portalSelectionModeEnum = pgEnum('portal_selection_mode', ['ALL_PUBLIC', 'TAGGED', 'MANUAL']);
export const portalOverrideActionEnum = pgEnum('portal_override_action', ['INCLUDE', 'EXCLUDE']);

/**
 * The catalog of portals an agency can feed (S9-01): Kyero, thinkSPAIN, A Place in the Sun, generic XML; idealista
 * and Fotocasa listed as PLANNED. Global reference data (no tenant), written by staff and `pnpm exports:sync-channels`
 * (`withSystem`). `code` is the stable key writers (S9-02) are looked up by.
 */
export const portalChannels = pgTable(
  'portal_channels',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    status: portalChannelStatusEnum('status').notNull().default('AVAILABLE'),
    /** The credential keys a connection may store for this portal (all optional); empty: none needed. */
    credentialFields: text('credential_fields').array().notNull().default(sql`'{}'::text[]`),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('portal_channels_code_ck', sql`${t.code} ~ '^[a-z0-9-]{2,40}$'`)],
);

/**
 * An agency's connection to one portal (S9-01): which listings it sends (selection rule) and the portal's
 * credentials. Credentials are a `platform/crypto` envelope bound to (agency, table, column, row), never returned.
 * The feed token (S9-03 generates the files, S9-04 serves them at `/v2/portal-feeds/<token>/…`) is per connection,
 * random (32 bytes), shown once and stored only as its keyed hash (`HMAC_KEY`, purpose `exports.feed-token`) like
 * `website_feeds`; rotating replaces the hash, revoking sets `revoked_at`.
 *
 * STRICT: the serving path (S9-04) opens its own read of the token hash when it exists.
 */
export const agencyPortalConnections = pgTable(
  'agency_portal_connections',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    channelCode: text('channel_code')
      .notNull()
      .references(() => portalChannels.code),
    name: text('name').notNull(),
    /** Off: the connection keeps its setup and token but no feed is generated for it. */
    enabled: boolean('enabled').notNull().default(true),
    selectionMode: portalSelectionModeEnum('selection_mode').notNull().default('ALL_PUBLIC'),
    /** TAGGED only: the listing tag (lower case, as `property_tags.tag`); null otherwise. */
    selectionTag: text('selection_tag'),
    /** `platform/crypto` envelope of the JSON credentials; null: none stored. Never returned. */
    credentialsEnc: text('credentials_enc'),
    /** The names of the stored credentials (never their values), sorted: the dashboard lists them without decrypting. */
    credentialKeys: text('credential_keys').array().notNull().default(sql`'{}'::text[]`),
    /** `hmacSha256(HMAC_KEY, 'exports.feed-token', token)`; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** The token's last 4 characters (the dashboard shows which token is live). */
    tokenHint: text('token_hint').notNull(),
    tokenCreatedAt: timestamp('token_created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * The last feed validation run (S9-02, written by the generator, never bumps `version`): when it finished and how
     * many selected listings were valid (exported) and invalid (left out, see `portal_connection_issues`). Null: never run.
     */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastValidCount: integer('last_valid_count'),
    lastInvalidCount: integer('last_invalid_count'),
    /** The admin who created the connection (audit; no FK, so removing that user keeps the history). */
    createdBy: uuid('created_by').notNull(),
    /** Bumped on every change (optimistic concurrency, `VERSION_CONFLICT`). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + dashboard list: where agency_id = ? order by created_at, id (keyset)
    index('agency_portal_connections_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // target of the overrides' composite FK: an override belongs to a connection of its own agency
    unique('agency_portal_connections_agency_id_uq').on(t.agencyId, t.id),
    // the token's lookup (S9-04): where token_hash = ?
    uniqueIndex('agency_portal_connections_token_uq').on(t.tokenHash),
    // one connection per name and portal
    uniqueIndex('agency_portal_connections_name_uq').on(t.agencyId, t.channelCode, sql`lower(${t.name})`),
    check('agency_portal_connections_name_ck', sql`char_length(${t.name}) between 1 and 80`),
    check(
      'agency_portal_connections_tag_ck',
      sql`(${t.selectionMode} = 'TAGGED') = (${t.selectionTag} is not null)
        and (${t.selectionTag} is null or (char_length(${t.selectionTag}) between 1 and 40 and ${t.selectionTag} = lower(btrim(${t.selectionTag}))))`,
    ),
    check('agency_portal_connections_hint_ck', sql`length(${t.tokenHint}) = 4`),
  ],
);

/**
 * Per-property choices of a connection (S9-01): INCLUDE sends a listing the rule would not (the whole selection in
 * MANUAL mode), EXCLUDE holds one back. Neither publishes anything: a listing that is not ACTIVE and PUBLIC is
 * never selected. Absent: the rule decides. At most `MAX_CONNECTION_OVERRIDES` per connection (service).
 */
export const portalConnectionProperties = pgTable(
  'portal_connection_properties',
  {
    connectionId: uuid('connection_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    action: portalOverrideActionEnum('action').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.propertyId] }),
    foreignKey({
      name: 'portal_connection_properties_connection_fk',
      columns: [t.agencyId, t.connectionId],
      foreignColumns: [agencyPortalConnections.agencyId, agencyPortalConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'portal_connection_properties_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    // the selection's keyset reads: where connection_id = ? and action = ? and property_id > ? order by property_id
    index('portal_connection_properties_action_idx').on(t.connectionId, t.action, t.propertyId),
    // a purged listing's overrides (cascade) and "where is this listing sent"
    index('portal_connection_properties_property_idx').on(t.propertyId),
  ],
);

/**
 * Listings a connection's last validation run left out, and why (S9-02): one row per selected listing that failed the
 * portal's checks — `errors` is `[{ code, params? }]` (codes of `PortalIssueCode`, the dashboard words them per locale).
 * Valid listings have no row. The generator rewrites the rows of each batch it checks and, when the run ends, deletes
 * the rows of earlier runs (`checked_at` older than the run's start): a listing no longer selected, or fixed, vanishes.
 */
export const portalConnectionIssues = pgTable(
  'portal_connection_issues',
  {
    connectionId: uuid('connection_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    errors: jsonb('errors').notNull(),
    /** The start of the run that wrote the row. */
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // keyset list of a connection's issues: where connection_id = ? and property_id > ? order by property_id
    primaryKey({ columns: [t.connectionId, t.propertyId] }),
    foreignKey({
      name: 'portal_connection_issues_connection_fk',
      columns: [t.agencyId, t.connectionId],
      foreignColumns: [agencyPortalConnections.agencyId, agencyPortalConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'portal_connection_issues_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    index('portal_connection_issues_property_idx').on(t.propertyId),
  ],
);
