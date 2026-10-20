/**
 * Tables owned by the websites module (PATTERNS §2, PLAN §6 Website delivery, §9.1). Only
 * `packages/core/src/modules/websites` imports this file (`pnpm check:boundaries`).
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
