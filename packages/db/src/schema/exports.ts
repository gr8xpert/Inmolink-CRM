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
/** S9-03: what started a feed run — an event (listing, selection, connection change) or the nightly sweep. */
export const portalFeedRunTriggerEnum = pgEnum('portal_feed_run_trigger', ['EVENT', 'NIGHTLY']);
/**
 * S9-03: WRITTEN — a new file is served · UNCHANGED — same content hash, nothing rewritten · FAILED — the previous
 * file stays served · SKIPPED — nothing generated (turned off, writer not enabled, agency not verified).
 */
export const portalFeedRunStatusEnum = pgEnum('portal_feed_run_status', ['WRITTEN', 'UNCHANGED', 'FAILED', 'SKIPPED']);

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
    /**
     * The served feed file (S9-03, written by the generator, never bumps `version`): the run whose object
     * (`portal-feeds/<connection>/<run>/feed.xml.gz`) is live, the SHA-256 (base64url) of its XML — the content hash
     * that decides whether a run rewrites it, and the strong ETag — its gzip size and listing count, and when its
     * content last changed. Null: no file yet. Read by feed-api only through `portal_feed_by_token()`.
     */
    feedRunId: uuid('feed_run_id'),
    feedSha256: text('feed_sha256'),
    feedBytes: integer('feed_bytes'),
    feedItemCount: integer('feed_item_count'),
    feedGeneratedAt: timestamp('feed_generated_at', { withTimezone: true }),
    /** The start of the last nightly run that covered this connection (S9-03): the nightly sweep's due check. */
    nightlyAt: timestamp('nightly_at', { withTimezone: true }),
    /**
     * S9-04, push portals: why the last push run stopped for good (`AUTH_REJECTED`, `CREDENTIALS_MISSING`,
     * `NOT_CONFIGURED`); the push job skips the connection until its credentials or on/off state change (a nightly run
     * tries again). Null: no standing problem. Worker state: never bumps `version`.
     */
    pushError: text('push_error'),
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
    // nightly sweep (S9-03): agencies with a live connection, keyset by agency_id
    index('agency_portal_connections_live_idx')
      .on(t.agencyId, t.nightlyAt)
      .where(sql`${t.enabled} and ${t.revokedAt} is null`),
    // one connection per name and portal
    uniqueIndex('agency_portal_connections_name_uq').on(t.agencyId, t.channelCode, sql`lower(${t.name})`),
    check('agency_portal_connections_name_ck', sql`char_length(${t.name}) between 1 and 80`),
    check(
      'agency_portal_connections_tag_ck',
      sql`(${t.selectionMode} = 'TAGGED') = (${t.selectionTag} is not null)
        and (${t.selectionTag} is null or (char_length(${t.selectionTag}) between 1 and 40 and ${t.selectionTag} = lower(btrim(${t.selectionTag}))))`,
    ),
    check('agency_portal_connections_hint_ck', sql`length(${t.tokenHint}) = 4`),
    check('agency_portal_connections_push_error_ck', sql`${t.pushError} is null or char_length(${t.pushError}) <= 40`),
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

/**
 * Run history of a connection's feed (S9-03): one row per generator run, shown on `/portals/[id]`. Retention-bounded:
 * the generator keeps the newest `FEED_RUNS_KEPT` per connection (older ones are deleted in the run's own
 * transaction), so the table stays at most connections × that many rows.
 */
export const portalFeedRuns = pgTable(
  'portal_feed_runs',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    trigger: portalFeedRunTriggerEnum('trigger').notNull(),
    status: portalFeedRunStatusEnum('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    validCount: integer('valid_count'),
    invalidCount: integer('invalid_count'),
    /** Gzip size of the file the run produced (WRITTEN, UNCHANGED). */
    bytes: integer('bytes'),
    /** WRITTEN / UNCHANGED: the content hash; FAILED / SKIPPED: null. */
    sha256: text('sha256'),
    /** FAILED: an error code (`TOO_LARGE`, `GENERATION_FAILED`); SKIPPED: why (`disabled`, `writer-disabled`, …). */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'portal_feed_runs_connection_fk',
      columns: [t.agencyId, t.connectionId],
      foreignColumns: [agencyPortalConnections.agencyId, agencyPortalConnections.id],
    }).onDelete('cascade'),
    // the dashboard's run list and the retention delete: where agency_id = ? and connection_id = ? order by id desc
    index('portal_feed_runs_connection_idx').on(t.agencyId, t.connectionId, t.id),
    check('portal_feed_runs_reason_ck', sql`${t.reason} is null or char_length(${t.reason}) <= 40`),
  ],
);

/** S9-04: SYNCED — the portal holds the payload hashed in `payload_hash` · FAILED — the portal refused that payload for good · WITHDRAWN — taken down at the portal. */
export const portalSyncStateEnum = pgEnum('portal_sync_state', ['SYNCED', 'FAILED', 'WITHDRAWN']);

/**
 * Per-listing state of a push-style portal connection (idealista, Fotocasa; S9-04): the id the portal gave the listing
 * and the hash of the payload last sent (or refused), so a run pushes only what changed and withdraws what left the
 * selection. One row per (connection, listing) that was ever pushed; feed portals have none. Written by the push job
 * (`app_system`) only. The listing FK cascades: a purged listing's row goes with it (listings are soft-deleted
 * first, which the selection turns into a withdrawal).
 */
export const portalListingSync = pgTable(
  'portal_listing_sync',
  {
    connectionId: uuid('connection_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    agencyId: uuid('agency_id').notNull(),
    state: portalSyncStateEnum('state').notNull(),
    /** The portal's own id for the advert (null until the first successful publish). */
    remoteId: text('remote_id'),
    /** SYNCED: hash of the payload the portal holds · FAILED: hash of the payload it refused. */
    payloadHash: text('payload_hash').notNull(),
    /** FAILED: the error code (`PortalPushError.code`). */
    errorCode: text('error_code'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.propertyId] }),
    foreignKey({
      name: 'portal_listing_sync_connection_fk',
      columns: [t.agencyId, t.connectionId],
      foreignColumns: [agencyPortalConnections.agencyId, agencyPortalConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'portal_listing_sync_property_fk',
      columns: [t.propertyId, t.agencyId],
      foreignColumns: [properties.id, properties.agencyId],
    }).onDelete('cascade'),
    index('portal_listing_sync_property_idx').on(t.propertyId),
    check('portal_listing_sync_error_ck', sql`${t.errorCode} is null or char_length(${t.errorCode}) <= 40`),
  ],
);
