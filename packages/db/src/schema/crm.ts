import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Tables owned by the crm module (PATTERNS §2). Only `packages/core/src/modules/crm` imports
 * this file (`pnpm check:boundaries`). Every table is STRICT: contacts are the agency's clients (PII) and never
 * readable by another agency, the network or the public.
 */

/** `date_trunc('milliseconds', col, 'UTC')`: the keyset sort key (`keysetOrder`, S2-F1), indexable. */
const keysetTime = (col: unknown) => sql`date_trunc('milliseconds', ${col}, 'UTC')`;

/**
 * A contact (S10-01, PLAN §6 CRM): a person the agency deals with — buyer, seller, tenant, landlord (any mix).
 * E-mails and phones are rows of their own (`contact_emails`, `contact_phones`), unique per agency, so the database
 * itself refuses a second contact with the same address or number; `primary_email` / `primary_phone` repeat the
 * first one for the list. A merged contact keeps its row (`merged_into_id`, `deleted_at` set) so links to it can be
 * followed to the survivor.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The agent responsible for the contact (no FK: a removed member's contacts stay); null = the agency's. */
    ownerUserId: uuid('owner_user_id'),
    /** `BUYER`, `SELLER`, `TENANT`, `LANDLORD` (checked). */
    types: text('types').array().notNull().default(sql`'{}'::text[]`),
    firstName: text('first_name'),
    lastName: text('last_name'),
    /** The first of the contact's e-mails / phones (normalized), for the list; null when it has none. */
    primaryEmail: text('primary_email'),
    primaryPhone: text('primary_phone'),
    /** The language the contact is written to in (`en`, `es`, …); null = unknown. */
    language: text('language'),
    /** Where the contact came from (`MANUAL`, `WEBSITE`, `PORTAL`, `IMPORT`, …; checked). */
    source: text('source').notNull().default('MANUAL'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Consent to marketing (newsletters, property alerts) and to processing the data; `_at`: when it was recorded. */
    consentMarketing: boolean('consent_marketing').notNull().default(false),
    consentMarketingAt: timestamp('consent_marketing_at', { withTimezone: true }),
    consentProcessing: boolean('consent_processing').notNull().default(false),
    consentProcessingAt: timestamp('consent_processing_at', { withTimezone: true }),
    /** Never contact (no e-mail, call or automated message), whatever the consents say. */
    doNotContact: boolean('do_not_contact').notNull().default(false),
    /** Set when the contact was merged into another one (then `deleted_at` is set too). */
    mergedIntoId: uuid('merged_into_id'),
    /**
     * SHA-256 of the creating member's `Idempotency-Key` (with their user id): a retried `POST` within 24 h answers this
     * contact instead of failing on its own e-mail. Null without a key.
     */
    idempotencyHash: text('idempotency_hash'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // contact list: where agency_id = ? and deleted_at is null order by created_at desc, id desc (keyset)
    index('contacts_agency_created_idx')
      .on(t.agencyId, keysetTime(t.createdAt), t.id)
      .where(sql`${t.deletedAt} is null`),
    // "my contacts": where agency_id = ? and owner_user_id = ? and deleted_at is null order by created_at desc, id desc
    index('contacts_agency_owner_created_idx')
      .on(t.agencyId, t.ownerUserId, keysetTime(t.createdAt), t.id)
      .where(sql`${t.deletedAt} is null`),
    // FK + a merge flattens the chain of contacts merged into the one it closes: where merged_into_id = ?
    index('contacts_merged_into_idx').on(t.agencyId, t.mergedIntoId).where(sql`${t.mergedIntoId} is not null`),
    // POST replay: where agency_id = ? and idempotency_hash = ?
    uniqueIndex('contacts_idempotency_uq')
      .on(t.agencyId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
    // the composite FKs of the identifier and note tables (a row never points at another agency's contact)
    uniqueIndex('contacts_agency_id_uq').on(t.agencyId, t.id),
    check('contacts_types_ck', sql`${t.types} <@ array['BUYER', 'SELLER', 'TENANT', 'LANDLORD']::text[]`),
    check(
      'contacts_source_ck',
      sql`${t.source} in ('MANUAL', 'WEBSITE', 'PORTAL', 'IMPORT', 'REFERRAL', 'WALK_IN', 'PHONE', 'SOCIAL', 'OTHER')`,
    ),
    check('contacts_merged_ck', sql`${t.mergedIntoId} is null or ${t.deletedAt} is not null`),
    // a merged contact points at a contact of its own agency
    foreignKey({
      name: 'contacts_merged_into_fk',
      columns: [t.agencyId, t.mergedIntoId],
      foreignColumns: [t.agencyId, t.id],
    }),
  ],
);

/** A contact's e-mail addresses, lower-cased and trimmed; one contact per address per agency (duplicate detection). */
export const contactEmails = pgTable(
  'contact_emails',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    email: text('email').notNull(),
    /** Order on the contact (0 = primary). */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // duplicate detection: where agency_id = ? and email = any(?)
    uniqueIndex('contact_emails_agency_email_uq').on(t.agencyId, t.email),
    // FK + a contact's e-mails: where contact_id = any(?) order by position
    index('contact_emails_contact_idx').on(t.agencyId, t.contactId, t.position),
    check('contact_emails_normalized_ck', sql`${t.email} = lower(btrim(${t.email})) and length(${t.email}) <= 254`),
    foreignKey({
      name: 'contact_emails_contact_fk',
      columns: [t.agencyId, t.contactId],
      foreignColumns: [contacts.agencyId, contacts.id],
    }).onDelete('cascade'),
  ],
);

/** A contact's phone numbers in E.164 (`+34600123456`); one contact per number per agency (duplicate detection). */
export const contactPhones = pgTable(
  'contact_phones',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    phone: text('phone').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // duplicate detection: where agency_id = ? and phone = any(?)
    uniqueIndex('contact_phones_agency_phone_uq').on(t.agencyId, t.phone),
    // FK + a contact's phones: where contact_id = any(?) order by position
    index('contact_phones_contact_idx').on(t.agencyId, t.contactId, t.position),
    check('contact_phones_e164_ck', sql`${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    foreignKey({
      name: 'contact_phones_contact_fk',
      columns: [t.agencyId, t.contactId],
      foreignColumns: [contacts.agencyId, contacts.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The list filters' side table (S10-01 review): one row per tag (`tag:<tag>`) and type (`type:BUYER`) of an open
 * contact, kept in step with `contacts.tags` / `contacts.types` by every writer (`repo.syncFacets`, in the write's
 * statement batch). Under RLS an array `@>` is not leakproof, so it can never be an index condition for `app_user`
 * (a GIN index on the arrays would never be used); text `=` is, so `(agency_id, facet)` is (like `property_tags`).
 */
export const contactFacets = pgTable(
  'contact_facets',
  {
    agencyId: uuid('agency_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    facet: text('facet').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.facet] }),
    // list filter: where agency_id = ? and facet = 'tag:…' (the agency's contacts with this tag / type)
    index('contact_facets_agency_facet_idx').on(t.agencyId, t.facet, t.contactId),
    check('contact_facets_facet_ck', sql`${t.facet} ~ '^(tag|type):' and length(${t.facet}) <= 60`),
    foreignKey({
      name: 'contact_facets_contact_fk',
      columns: [t.agencyId, t.contactId],
      foreignColumns: [contacts.agencyId, contacts.id],
    }).onDelete('cascade'),
  ],
);

/** Free-text notes on a contact (internal: never shown to the contact or in Client Mode). */
export const contactNotes = pgTable(
  'contact_notes',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    /** The member who wrote it (no FK: a removed member's notes stay). */
    authorUserId: uuid('author_user_id'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + a contact's notes, newest first: where agency_id = ? and contact_id = ? order by created_at desc, id desc
    index('contact_notes_contact_created_idx').on(t.agencyId, t.contactId, keysetTime(t.createdAt), t.id),
    check('contact_notes_body_ck', sql`length(${t.body}) between 1 and 10000`),
    foreignKey({
      name: 'contact_notes_contact_fk',
      columns: [t.agencyId, t.contactId],
      foreignColumns: [contacts.agencyId, contacts.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A CSV / Excel import of contacts (S10-01): the uploaded file (private storage, `crm/contact-imports/<agency>/<id>`),
 * the member's column mapping and the run's counts. The file is deleted when the run ends, or by the daily sweep when
 * the upload was never started. `errors` holds row numbers and codes only (never cell values: PII).
 */
export const contactImports = pgTable(
  'contact_imports',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    createdBy: uuid('created_by').notNull(),
    /** `csv` or `xlsx`, from the file's first bytes. */
    fileKind: text('file_kind').notNull(),
    fileBytes: integer('file_bytes').notNull(),
    /** `UPLOADED` → `QUEUED` → `RUNNING` → `SUCCEEDED` | `FAILED`; `EXPIRED` when an upload was never started. */
    status: text('status').notNull().default('UPLOADED'),
    /** The header row as uploaded (column names, clipped). */
    headers: text('headers').array().notNull().default(sql`'{}'::text[]`),
    /** `ContactImportMapping` (contracts): which column feeds which field, plus defaults. */
    mapping: jsonb('mapping'),
    /** `SKIP` a row matching an existing contact, or `MERGE` its new details into it. */
    onDuplicate: text('on_duplicate').notNull().default('SKIP'),
    totalRows: integer('total_rows').notNull().default(0),
    /** Data rows already handled (the run's checkpoint: a retried job resumes after them, never imports a row twice). */
    processedRows: integer('processed_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    mergedCount: integer('merged_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    invalidCount: integer('invalid_count').notNull().default(0),
    /** The first rows that could not be imported: `[{ row, code }]` (row = spreadsheet row number). */
    errors: jsonb('errors').notNull().default(sql`'[]'::jsonb`),
    /** Why the run failed (an error code, never a message with data). */
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** When the uploaded file was deleted from storage; null while it may still be there (the sweep retries). */
    fileDeletedAt: timestamp('file_deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the agency's imports, newest first: where agency_id = ? order by created_at desc, id desc
    index('contact_imports_agency_created_idx').on(t.agencyId, keysetTime(t.createdAt), t.id),
    // daily sweep of files left in storage (uploads never started, runs whose delete failed):
    // where file_deleted_at is null and created_at < ? order by created_at
    index('contact_imports_file_idx').on(t.createdAt).where(sql`${t.fileDeletedAt} is null`),
    check(
      'contact_imports_status_ck',
      sql`${t.status} in ('UPLOADED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')`,
    ),
    check('contact_imports_kind_ck', sql`${t.fileKind} in ('csv', 'xlsx')`),
    check('contact_imports_duplicate_ck', sql`${t.onDuplicate} in ('SKIP', 'MERGE')`),
    check('contact_imports_error_ck', sql`${t.errorCode} is null or length(${t.errorCode}) <= 64`),
  ],
);
