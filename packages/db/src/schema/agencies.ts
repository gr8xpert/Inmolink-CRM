import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the agencies module (PATTERNS §2, PLAN §3 #1 #3, §6 Identity). The agency is the
 * tenant. Only `packages/core/src/modules/agencies` imports this file (`pnpm check:boundaries`).
 *
 * `agencies` keys on `agency_id` (TS `id`): the tenant registry, RLS policies and the isolation suite
 * are all written against `agency_id`, so the tenant table itself uses that column as its key.
 */
export const agencyKindEnum = pgEnum('agency_kind', ['AGENCY', 'DEVELOPER', 'PARTNER']);
export const agencyStatusEnum = pgEnum('agency_status', ['PENDING', 'VERIFIED', 'SUSPENDED']);

export const agencies = pgTable(
  'agencies',
  {
    id: uuid('agency_id').primaryKey(),
    kind: agencyKindEnum('kind').notNull(),
    /** PENDING until staff verify the company (S1-03). Only VERIFIED unlocks SHARED/PUBLIC and API keys. */
    status: agencyStatusEnum('status').notNull().default('PENDING'),
    name: text('name').notNull(),
    /** CIF / NIF / NIE, normalized (`B12345674`). Set in onboarding. */
    taxId: text('tax_id'),
    addressLine: text('address_line'),
    city: text('city'),
    postalCode: text('postal_code'),
    /** ISO 3166-2:ES autonomous community (`ES-AN`). */
    region: text('region'),
    /** Content locale codes the agency works in. */
    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    /** Company details complete; staff verification can start. */
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // staff console (S1-09): duplicate-company checks and search by tax id
    index('agencies_tax_id_idx').on(t.taxId).where(sql`tax_id is not null`),
  ],
);

/** Per-agency settings, one row per agency (S1-06 adds commission, white-label and Client Mode options). */
export const agencySettings = pgTable('agency_settings', {
  agencyId: uuid('agency_id')
    .primaryKey()
    .references(() => agencies.id, { onDelete: 'cascade' }),
  /** Locales listings and the website are published in (PLAN §3 #14). */
  enabledLocales: text('enabled_locales').array().notNull(),
  /** Client registration validity (PLAN §3 #8, default 6 months). */
  registrationValidityDays: integer('registration_validity_days').notNull().default(180),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Localized agency texts (about, tagline) per content locale; edited in the profile (S1-06). */
export const agencyTranslations = pgTable(
  'agency_translations',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    tagline: text('tagline'),
    description: text('description'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agencyId, t.locale] })],
);
