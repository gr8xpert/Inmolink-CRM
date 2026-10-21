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

export const websiteModeEnum = pgEnum('website_mode', ['WP_PLUGIN', 'WIDGET', 'HOSTED']);
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
    siteId: uuid('site_id').notNull(),
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
