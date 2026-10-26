/**
 * Tables owned by the websites module (PATTERNS §2, PLAN §6 Website delivery, §9.1). Only
 * `packages/core/src/modules/websites` imports this file (`pnpm check:boundaries`).
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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/** IFRAME (S7-F8): the site's pages are served by `apps/public` under `/embed/<site>/…`, framed by its domains only. */
export const websiteModeEnum = pgEnum('website_mode', ['WP_PLUGIN', 'WIDGET', 'HOSTED', 'IFRAME']);
export const inventoryPolicyEnum = pgEnum('inventory_policy', ['OWN_ONLY', 'OWN_PLUS_NETWORK', 'CUSTOM']);

/**
 * An agency's website (S7-01): where it runs, which listings it shows (inventory policy) and how it presents them
 * (reference prefix, locales, contact overrides). Website API keys are bound to one site (`api_keys.site_id`).
 *
 * PUBLIC_READ: feed-api reads a key's site as `app_public` before it has a tenant session. Every column is the
 * agency's public website configuration — nothing private lives here.
 */
export const websiteSites = pgTable(
  'website_sites',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Host names the site is served on (lower case, no scheme); informative until hosted sites (S7-07). */
    domains: text('domains').array().notNull().default(sql`'{}'::text[]`),
    mode: websiteModeEnum('mode').notNull(),
    inventoryPolicy: inventoryPolicyEnum('inventory_policy').notNull().default('OWN_ONLY'),
    /** CUSTOM only (contract `SiteInventoryFilters`); null for the other policies. Config, never filtered on in SQL. */
    inventoryFilters: jsonb('inventory_filters'),
    /** Shown before network listings' references on this site (white-label, S7-02); null: none. */
    referencePrefix: text('reference_prefix'),
    /** Content locales the site publishes (`CONTENT_LOCALES`), the default first. */
    locales: text('locales').array().notNull(),
    defaultLocale: text('default_locale').notNull(),
    /** Contact details shown instead of the agency's (contract `SiteContact`); null: the agency's own. */
    contact: jsonb('contact'),
    /** Bumped on every change (cache entries and ETags of the site's answers). */
    version: integer('version').notNull().default(1),
    /**
     * S13-F21: the agency's plan in force (AI budgets of the website API), kept by the worker (`websites.syncSitePlan`
     * on billing's plan events, and a daily sweep); null until first synced. Members never write it (guard).
     */
    planCode: text('plan_code'),
    /**
     * S13-F21: when the website API stops serving the site — set to the end of the notice period
     * (`WEBSITE_PLAN_NOTICE_DAYS`) when the agency's plan lost `website_api` while plans are enforced; null: it serves.
     * feed-api answers `PLAN_REQUIRED` (402) from then on, read with the cached site scope (no extra statement).
     */
    planEndsAt: timestamp('plan_ends_at', { withTimezone: true }),
    /** The admin who created the site (audit; no FK, so removing that user keeps the history). */
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + dashboard list: where agency_id = ? order by created_at, id (keyset)
    index('website_sites_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // target of api_keys (agency_id, site_id): a key is bound to a site of its own agency
    uniqueIndex('website_sites_agency_id_uq').on(t.agencyId, t.id),
    check('website_sites_prefix_ck', sql`${t.referencePrefix} is null or ${t.referencePrefix} ~ '^[A-Z0-9]{1,6}$'`),
    check('website_sites_filters_ck', sql`(${t.inventoryPolicy} = 'CUSTOM') = (${t.inventoryFilters} is not null)`),
    check(
      'website_sites_locales_ck',
      sql`cardinality(${t.locales}) between 1 and 20 and ${t.defaultLocale} = ${t.locales}[1]`,
    ),
  ],
);

/**
 * A site's XML feed (S7-07, PLAN §9.5): the site's inventory as Kyero v3 and generic XML, for web designers who want
 * XML instead of the API. The feed is fetched at `/v2/feeds/<token>/<file>` (feed-api, CDN-cached): the token is
 * per site, random (32 bytes), shown once, and stored only as its keyed hash (`HMAC_KEY`, purpose
 * `websites.feed-token`); rotating it replaces the hash (the old URL stops working), revoking it sets `revoked_at`.
 * Never the API key. The generator (worker, `websiteApi.generateSiteFeed`) writes the files to object storage under
 * `site-feeds/<site>/<run>/` and records the run here.
 *
 * PUBLIC_READ (`revoked_at is null`): feed-api looks a token up as `app_public` before it knows the tenant; only the
 * run columns and the site are read there. `created_by` and `last_error` are not public.
 */
export const websiteFeeds = pgTable(
  'website_feeds',
  {
    siteId: uuid('site_id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /** `hmacSha256(HMAC_KEY, 'websites.feed-token', token)`; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** The token's last 4 characters (the dashboard shows which token is live). */
    tokenHint: text('token_hint').notNull(),
    tokenCreatedAt: timestamp('token_created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * HMAC of the `Idempotency-Key` the token was set with (S7-07 review): a retried request within 24 h answers the
     * same token (re-derived, never stored) instead of rotating again. Null without one.
     */
    idempotencyHash: text('idempotency_hash'),
    /** The admin who last set the token (audit; no FK). */
    createdBy: uuid('created_by').notNull(),
    /** The generation run whose files are served (`site-feeds/<site>/<run>/`); null until the first run. */
    runId: uuid('run_id'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    /** Listings and units in the generic feed, and in the Kyero feed (sale and monthly or weekly rentals with a price). */
    itemCount: integer('item_count'),
    kyeroCount: integer('kyero_count'),
    /** SHA-256 (base64url) of each served file (gzip bytes): the strong ETag. */
    kyeroSha256: text('kyero_sha256'),
    genericSha256: text('generic_sha256'),
    /** Why the last run failed (an error code, never a message with data); null after a success. */
    lastError: text('last_error'),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // feed-api: where token_hash = ? (the token's lookup)
    uniqueIndex('website_feeds_token_uq').on(t.tokenHash),
    // FK + the agency's feeds (a listing change regenerates them): where agency_id = ? and revoked_at is null
    index('website_feeds_agency_idx').on(t.agencyId),
    // periodic refresh: where revoked_at is null and (generated_at < ? or generated_at is null) order by generated_at
    index('website_feeds_refresh_idx').on(t.generatedAt).where(sql`${t.revokedAt} is null`),
    check('website_feeds_hint_ck', sql`length(${t.tokenHint}) = 4`),
    check('website_feeds_error_ck', sql`${t.lastError} is null or length(${t.lastError}) <= 64`),
    foreignKey({
      name: 'website_feeds_site_fk',
      columns: [t.agencyId, t.siteId],
      foreignColumns: [websiteSites.agencyId, websiteSites.id],
      // A site's feed goes with the site (sites are never deleted by tenants; an agency's deletion removes both).
    }).onDelete('cascade'),
  ],
);

export const websiteLeadKindEnum = pgEnum('website_lead_kind', ['ENQUIRY', 'VIEWING_REQUEST']);
/** How the visitor was checked: Cloudflare Turnstile, or a site server (secret key) that ran its own check. */
export const websiteLeadVerificationEnum = pgEnum('website_lead_verification', ['TURNSTILE', 'SERVER_KEY']);

/**
 * Inbound leads from an agency's websites (S7-05, PLAN §9.1 `POST /v2/leads`, `/v2/viewing-requests`): a visitor's
 * enquiry or viewing request as the site's form sent it. Promoted to CRM leads (contacts, routing, inbox) in S10-02.
 *
 * `agency_id` is the **presenting** agency — the site's (PLAN §3 #12: website leads belong to it, also for another
 * agency's network listing). STRICT: the listing's owner never reads the row (it would see the client's details);
 * `owner_agency_id` only records whose listing it was. Written by feed-api as `app_intake` (`withIntake`: insert, and
 * read back the idempotency columns only), read and acknowledged by the worker (`app_system`).
 */
export const websiteLeads = pgTable(
  'website_leads',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /**
     * The site whose form sent it; null: the public portal (S15-02, inmolink.es) — a marketplace lead, whose
     * `agency_id` is the listing's owner (PLAN §3 #12: marketplace → the listing owner), never a site's agency.
     */
    siteId: uuid('site_id'),
    kind: websiteLeadKindEnum('kind').notNull(),
    /**
     * HMAC of the client's `Idempotency-Key` (purpose-separated, base64url): a repeated submission with the same key
     * on the same site is the same lead. Cleared after the replay window (`websites.pruneLeadIdempotency`).
     */
    idempotencyHash: text('idempotency_hash'),
    /** HMAC of the canonical request body: the same key with another body is refused, not replayed. */
    requestHash: text('request_hash').notNull(),
    verification: websiteLeadVerificationEnum('verification').notNull(),
    /** The listing or unit the visitor asked about (null: a general enquiry). Not a FK: listings and units differ. */
    targetKind: text('target_kind'),
    targetId: uuid('target_id'),
    /** Whose listing it is when not the presenting agency's (a network listing): the introducer relation of S10-02. */
    ownerAgencyId: uuid('owner_agency_id'),
    /** The reference as the site showed it (`<prefix>-<code>` for network listings). */
    shownRef: text('shown_ref'),
    /** The visitor's language: one of the site's locales (the acknowledgement is written in it). */
    locale: text('locale').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** HMAC of the normalized e-mail (purpose-separated): acknowledgement limits per recipient, without the address. */
    emailHash: text('email_hash').notNull(),
    /** The posting key's rate tier: the site's daily acknowledgement cap follows it. */
    keyTier: text('key_tier').notNull(),
    phone: text('phone'),
    message: text('message'),
    /** Viewing requests: the preferred slots as the form sent them (contract `ViewingSlot[]`); never filtered on. */
    viewingSlots: jsonb('viewing_slots'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    /** The page the form was on (https only). */
    pageUrl: text('page_url'),
    /** When the visitor's acknowledgement (speed-to-lead, PLAN §3 #60) and the agency's notification went out. */
    ackSentAt: timestamp('ack_sent_at', { withTimezone: true }),
    /** Why no acknowledgement was sent (a per-recipient or per-site daily cap); null: sent, or not yet. */
    ackSkippedReason: text('ack_skipped_reason'),
    agencyNotifiedAt: timestamp('agency_notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + the agency's lead inbox (S10-02): where agency_id = ? order by created_at, id (keyset)
    index('website_leads_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
    // FK (agency_id, site_id) → website_sites
    index('website_leads_site_idx').on(t.agencyId, t.siteId),
    // intake: insert … on conflict (site_id, idempotency_hash) do nothing; replay: where site_id = ? and idempotency_hash = ?
    uniqueIndex('website_leads_idempotency_uq')
      .on(t.siteId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
    // S15-02 portal intake (no site): insert … on conflict (idempotency_hash) where site_id is null and
    // idempotency_hash is not null do nothing; replay (RLS: the owner's rows): where site_id is null and
    // idempotency_hash = ?. Not per agency: `app_intake` may not read `agency_id` (an ON CONFLICT target needs it),
    // and the key is the browser's random UUID.
    uniqueIndex('website_leads_portal_idempotency_uq')
      .on(t.idempotencyHash)
      .where(sql`${t.siteId} is null and ${t.idempotencyHash} is not null`),
    // replay-window prune: where idempotency_hash is not null and created_at < ? (batches)
    index('website_leads_idempotency_created_idx').on(t.createdAt).where(sql`${t.idempotencyHash} is not null`),
    // acknowledgement limits: acks sent to one recipient (any site, or one site) since …
    index('website_leads_recipient_ack_idx').on(t.emailHash, t.ackSentAt).where(sql`${t.ackSentAt} is not null`),
    // … and by one site since …
    index('website_leads_site_ack_idx').on(t.siteId, t.ackSentAt).where(sql`${t.ackSentAt} is not null`),
    check('website_leads_key_tier_ck', sql`${t.keyTier} in ('STANDARD', 'HIGH')`),
    check(
      'website_leads_ack_skipped_ck',
      sql`${t.ackSkippedReason} is null or ${t.ackSkippedReason} in ('RECIPIENT_SITE_DAILY', 'RECIPIENT_DAILY', 'SITE_DAILY')`,
    ),
    foreignKey({
      name: 'website_leads_site_fk',
      columns: [t.agencyId, t.siteId],
      foreignColumns: [websiteSites.agencyId, websiteSites.id],
      // A lead names a site of its own agency. Not cascade: an agency's deletion removes both in one statement.
    }).onDelete('no action'),
    check(
      'website_leads_target_ck',
      sql`(${t.targetKind} is null and ${t.targetId} is null and ${t.shownRef} is null and ${t.ownerAgencyId} is null)
        or (${t.targetKind} in ('LISTING', 'UNIT') and ${t.targetId} is not null and ${t.shownRef} is not null)`,
    ),
    // A viewing request is about a listing and names its preferred slots.
    check(
      'website_leads_viewing_ck',
      sql`${t.kind} <> 'VIEWING_REQUEST' or (${t.targetId} is not null and ${t.viewingSlots} is not null)`,
    ),
    check(
      'website_leads_sizes_ck',
      sql`length(${t.name}) <= 120 and length(${t.email}) <= 254 and coalesce(length(${t.phone}), 0) <= 32
        and coalesce(length(${t.message}), 0) <= 4000 and coalesce(length(${t.pageUrl}), 0) <= 2048
        and length(${t.locale}) <= 10 and coalesce(length(${t.shownRef}), 0) <= 64`,
    ),
  ],
);
