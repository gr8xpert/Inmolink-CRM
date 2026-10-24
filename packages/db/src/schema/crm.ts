import { type SQL, sql } from 'drizzle-orm';
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
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/**
 * Tables owned by the crm module (PATTERNS §2). Only `packages/core/src/modules/crm` imports
 * this file (`pnpm check:boundaries`). Every table is STRICT — contacts are the agency's clients (PII) and never
 * readable by another agency, the network or the public — except `lead_introductions` (S10-02), which the introduced
 * owner agency reads and which holds nothing of the client. `activities` (S10-04) is partitioned by month.
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
    /**
     * `created_at` to the millisecond (stored, S10-02 review): the list's keyset key. A plain column, so the cursor's
     * row comparison `(created_ms, id) < (?, ?)` is an index condition under RLS — `date_trunc` is not leakproof.
     */
    createdMs: timestamp('created_ms', { withTimezone: true })
      .notNull()
      .generatedAlwaysAs((): SQL => sql`date_trunc('milliseconds', created_at, 'UTC')`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // contact list: where agency_id = ? and deleted_at is null and (created_ms, id) < (?, ?)
    // order by created_ms desc, id desc (keyset)
    index('contacts_agency_created_idx').on(t.agencyId, t.createdMs, t.id).where(sql`${t.deletedAt} is null`),
    // "my contacts": … and owner_user_id = ?, same keyset
    index('contacts_agency_owner_created_idx')
      .on(t.agencyId, t.ownerUserId, t.createdMs, t.id)
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

/** The lead sources (`LEAD_SOURCES` in contracts), as a check constraint's list. */
const leadSourceList = sql.raw(
  `'WEBSITE', 'IFRAME', 'SELECTION', 'PORTFOLIO', 'PORTAL', 'MARKETPLACE', 'DEVELOPER_PORTAL', 'CHATBOT', 'WHATSAPP', 'MANUAL'`,
);

/**
 * A lead (S10-02, PLAN §3 #12, §7 M8): a client's enquiry about a listing, development or unit — or a general one — in
 * the inbox of the agency it is routed to (`agency_id`, the holder). Routing by source (`crm/routing.ts`): marketplace
 * → the listing owner; website, iFrame, selection, portfolio, portal, chatbot, WhatsApp, manual → the presenting
 * agency; developer portal → the presenting agency, with the developer introduced. Only the holder reads the lead and
 * its client (STRICT); when the target is another agency's (`owner_agency_id`: a network listing, a developer's unit)
 * that agency gets a `lead_introductions` row instead — the introducer and the target, never the client.
 */
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** The client (a contact of the holder). A merge re-points it (`CONTACT_REFERENCES`). */
    contactId: uuid('contact_id').notNull(),
    /** Where the lead came from (`LEAD_SOURCES`, checked). */
    source: text('source').notNull(),
    /** `ENQUIRY` or `VIEWING_REQUEST`. */
    kind: text('kind').notNull().default('ENQUIRY'),
    /** `NEW` → `IN_PROGRESS` → `WON` | `LOST`; `SPAM` (checked). Customizable stages are S10-03's. */
    status: text('status').notNull().default('NEW'),
    /** The agency that presented the target to the client (a site's agency); null: the owner's own channel. */
    presentingAgencyId: uuid('presenting_agency_id'),
    /** The target's owner when it is not the holder (network listing, developer's unit): the introduced agency. */
    ownerAgencyId: uuid('owner_agency_id'),
    /** What the client asked about: `LISTING`, `DEVELOPMENT` or `UNIT` (no FK: tables of other modules). */
    targetKind: text('target_kind'),
    targetId: uuid('target_id'),
    /** The reference as the client saw it (`<prefix>-<code>` on a partner site). */
    shownRef: text('shown_ref'),
    /** The inbound record it was promoted from (`website_leads.id`): one lead per inbound lead (idempotent). */
    inboundLeadId: uuid('inbound_lead_id'),
    /** The client's message (internal: never shown to the owner agency or in Client Mode). */
    message: text('message'),
    /** The client's language. */
    locale: text('locale'),
    /**
     * The details the client gave on the form, as given (S10-02 review): an inbound lead for an existing contact never
     * rewrites the contact (name, identifiers, consent) — the agent compares and updates it by hand.
     */
    visitorName: text('visitor_name'),
    visitorEmail: text('visitor_email'),
    visitorPhone: text('visitor_phone'),
    visitorMarketingConsent: boolean('visitor_marketing_consent'),
    /** The member the lead is assigned to (routing rule or by hand); null: unassigned. No FK: a removed member's stay. */
    assignedUserId: uuid('assigned_user_id'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    /** When the lead first left `NEW` (response time per lead, agent and agency). */
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    /** The member who entered a manual lead; null for inbound leads. */
    createdBy: uuid('created_by'),
    /** SHA-256 of the creating member's `Idempotency-Key` (with their user id): a retried `POST` within 24 h replays. */
    idempotencyHash: text('idempotency_hash'),
    /** SHA-256 of the canonical request body of that `POST`: the same key with another body is refused, not replayed. */
    requestHash: text('request_hash'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** `created_at` to the millisecond (stored): the keyset sort key — a plain column, so its `<` is leakproof under RLS. */
    createdMs: timestamp('created_ms', { withTimezone: true })
      .notNull()
      .generatedAlwaysAs((): SQL => sql`date_trunc('milliseconds', created_at, 'UTC')`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // inbox: where agency_id = ? and (created_ms, id) < (?, ?) order by created_ms desc, id desc (keyset)
    index('leads_agency_created_idx').on(t.agencyId, t.createdMs, t.id),
    // my / unassigned leads: … and assigned_user_id = ? (or is null), same keyset
    index('leads_agency_assigned_created_idx').on(t.agencyId, t.assignedUserId, t.createdMs, t.id),
    // status filter: … and status = ?, same keyset
    index('leads_agency_status_created_idx').on(t.agencyId, t.status, t.createdMs, t.id),
    // source filter: … and source = ?, same keyset
    index('leads_agency_source_created_idx').on(t.agencyId, t.source, t.createdMs, t.id),
    // FK + a merge re-points a contact's leads: where agency_id = ? and contact_id = ?
    index('leads_contact_idx').on(t.agencyId, t.contactId),
    // promotion: one lead per inbound lead (where agency_id = ? and inbound_lead_id = ?)
    uniqueIndex('leads_inbound_uq').on(t.agencyId, t.inboundLeadId).where(sql`${t.inboundLeadId} is not null`),
    // POST replay: where agency_id = ? and idempotency_hash = ?
    uniqueIndex('leads_idempotency_uq').on(t.agencyId, t.idempotencyHash).where(sql`${t.idempotencyHash} is not null`),
    // the composite FK of `lead_introductions` (an introduction names a lead of the introducer)
    unique('leads_agency_id_uq').on(t.agencyId, t.id),
    check('leads_source_ck', sql`${t.source} in (${leadSourceList})`),
    check('leads_kind_ck', sql`${t.kind} in ('ENQUIRY', 'VIEWING_REQUEST')`),
    check('leads_status_ck', sql`${t.status} in ('NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM')`),
    check(
      'leads_target_ck',
      sql`(${t.targetKind} is null and ${t.targetId} is null and ${t.shownRef} is null and ${t.ownerAgencyId} is null)
        or (${t.targetKind} in ('LISTING', 'DEVELOPMENT', 'UNIT') and ${t.targetId} is not null)`,
    ),
    check('leads_owner_ck', sql`${t.ownerAgencyId} is null or ${t.ownerAgencyId} <> ${t.agencyId}`),
    check(
      'leads_sizes_ck',
      sql`coalesce(length(${t.message}), 0) <= 4000 and coalesce(length(${t.shownRef}), 0) <= 64
        and coalesce(length(${t.locale}), 0) <= 10 and coalesce(length(${t.visitorName}), 0) <= 120
        and coalesce(length(${t.visitorEmail}), 0) <= 254 and coalesce(length(${t.visitorPhone}), 0) <= 32`,
    ),
    check('leads_assigned_ck', sql`(${t.assignedUserId} is null) = (${t.assignedAt} is null)`),
    check('leads_idempotency_ck', sql`(${t.idempotencyHash} is null) = (${t.requestHash} is null)`),
    foreignKey({
      name: 'leads_contact_fk',
      columns: [t.agencyId, t.contactId],
      foreignColumns: [contacts.agencyId, contacts.id],
    }),
  ],
);

/**
 * The owner's side of a lead on its target (S10-02, PLAN §3 #12): "agency X introduced a client for your listing".
 * Written by the holder (the introducer) in the lead's transaction and never changed (immutable: `app_user` reads and
 * appends; a lead's deletion cascades as the table owner). The owner agency reads it — NETWORK_READ on
 * `owner_agency_id = app_agency()` — and never anything of the client: there is no contact, name, e-mail, phone or
 * message column (client details reach the owner only through a registration, S11-01). RLS shares whole rows: never
 * add a private column here.
 */
export const leadIntroductions = pgTable(
  'lead_introductions',
  {
    leadId: uuid('lead_id').primaryKey(),
    /** The introducer: the lead's holder. */
    agencyId: uuid('agency_id').notNull(),
    /** The target's owner, who reads the row. */
    ownerAgencyId: uuid('owner_agency_id').notNull(),
    source: text('source').notNull(),
    kind: text('kind').notNull().default('ENQUIRY'),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    /** Entered by a member of the introducer (a phone call, a portal e-mail), not sent by the client through a channel. */
    handEntered: boolean('hand_entered').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** `created_at` to the millisecond (stored): the keyset sort key, leakproof under RLS. */
    createdMs: timestamp('created_ms', { withTimezone: true })
      .notNull()
      .generatedAlwaysAs((): SQL => sql`date_trunc('milliseconds', created_at, 'UTC')`),
  },
  (t) => [
    // the owner's introductions: where owner_agency_id = ? and (created_ms, lead_id) < (?, ?)
    // order by created_ms desc, lead_id desc
    index('lead_introductions_owner_created_idx').on(t.ownerAgencyId, t.createdMs, t.leadId),
    // FK (agency_id, lead_id) → leads
    index('lead_introductions_agency_idx').on(t.agencyId, t.leadId),
    check('lead_introductions_owner_ck', sql`${t.ownerAgencyId} <> ${t.agencyId}`),
    check('lead_introductions_target_ck', sql`${t.targetKind} in ('LISTING', 'DEVELOPMENT', 'UNIT')`),
    check('lead_introductions_kind_ck', sql`${t.kind} in ('ENQUIRY', 'VIEWING_REQUEST')`),
    check('lead_introductions_source_ck', sql`${t.source} in (${leadSourceList})`),
    foreignKey({
      name: 'lead_introductions_lead_fk',
      columns: [t.agencyId, t.leadId],
      foreignColumns: [leads.agencyId, leads.id],
    }).onDelete('cascade'),
  ],
);

/** The activity types (`ACTIVITY_TYPES` in contracts), as a check constraint's list. */
const activityTypeList = sql.raw(
  `'CALL', 'EMAIL', 'MEETING', 'VIEWING', 'OTHER', 'NOTE_ADDED', 'CONTACT_MERGED', 'LEAD_CREATED', 'LEAD_UPDATED', 'LISTING_STATUS_CHANGED'`,
);

/**
 * The activity timeline (S10-04, PLAN §6 CRM `Activity` [P]): what happened with a contact, a lead or a listing — a
 * call, e-mail, meeting or viewing logged by a member, a note, and what other changes record through the outbox (a
 * lead received or moved, a contact merged in, a listing's status). Polymorphic by columns, not by a `(type, id)`
 * pair: a row names every subject it concerns (a lead's activity also names its contact and its listing), so it shows
 * on each of their timelines with one index per subject.
 *
 * PARTITIONED by month on `occurred_at` (`PARTITION BY RANGE`, hand-added to the migration; pg_partman like
 * `audit_logs`), so the primary key and every unique index include it. `occurred_at` is stored to the millisecond
 * (checked): it is the keyset key itself, a plain column, so the cursor's `(occurred_at, id) < (?, ?)` is an index
 * condition under RLS (the S10-02 rule) and also prunes the newer months. Rows written from an outbox event carry its
 * id and the event's time: a redelivered event conflicts on `activities_event_uq` and adds nothing.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').notNull(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    /** When it happened, to the millisecond: the partition key and the timeline's sort key. */
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`date_trunc('milliseconds', now(), 'UTC')`),
    /** `ACTIVITY_TYPES` (checked): logged by hand (`CALL` … `OTHER`) or recorded by the system. */
    type: text('type').notNull(),
    /** The subjects (at least one). A merge re-points `contact_id` (`CONTACT_REFERENCES`). */
    contactId: uuid('contact_id'),
    leadId: uuid('lead_id'),
    /** A listing of the agency (no FK: properties' table). */
    listingId: uuid('listing_id'),
    /** The member who logged it; null for activities recorded from events. No FK: a removed member's stay. */
    actorUserId: uuid('actor_user_id'),
    /** The outbox event that recorded it (idempotent writers); null for activities logged by hand. */
    eventId: uuid('event_id'),
    /** SHA-256 of the logging member's `Idempotency-Key` (with their user id) and of the request body (24 h replay). */
    idempotencyHash: text('idempotency_hash'),
    requestHash: text('request_hash'),
    /** What the member wrote (a call's summary), or a note's opening. Internal: never in Client Mode. */
    body: text('body'),
    /** Small structured detail of a recorded activity (`{ status }`, `{ from, to }`, `{ mergedId }`): IDs and codes only. */
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    // a contact's timeline: where agency_id = ? and contact_id = ? and (occurred_at, id) < (?, ?)
    // order by occurred_at desc, id desc (keyset); also the FK and a merge's re-pointing (where contact_id = ?)
    index('activities_contact_idx')
      .on(t.agencyId, t.contactId, t.occurredAt, t.id)
      .where(sql`${t.contactId} is not null`),
    // a lead's timeline (same keyset) and the FK
    index('activities_lead_idx').on(t.agencyId, t.leadId, t.occurredAt, t.id).where(sql`${t.leadId} is not null`),
    // a listing's timeline (same keyset)
    index('activities_listing_idx')
      .on(t.agencyId, t.listingId, t.occurredAt, t.id)
      .where(sql`${t.listingId} is not null`),
    // the agency's feed (no subject): where agency_id = ? and (occurred_at, id) < (?, ?) (same keyset)
    index('activities_agency_idx').on(t.agencyId, t.occurredAt, t.id),
    // the agency's feed of one type: … and type = ?, same keyset
    index('activities_agency_type_idx').on(t.agencyId, t.type, t.occurredAt, t.id),
    // event writers: one row per outbox event (insert … on conflict do nothing)
    uniqueIndex('activities_event_uq').on(t.agencyId, t.eventId, t.occurredAt).where(sql`${t.eventId} is not null`),
    // POST replay: where agency_id = ? and idempotency_hash = ? (under the key's advisory lock)
    index('activities_idempotency_idx').on(t.agencyId, t.idempotencyHash).where(sql`${t.idempotencyHash} is not null`),
    check('activities_type_ck', sql`${t.type} in (${activityTypeList})`),
    check(
      'activities_subject_ck',
      sql`${t.contactId} is not null or ${t.leadId} is not null or ${t.listingId} is not null`,
    ),
    check('activities_ms_ck', sql`${t.occurredAt} = date_trunc('milliseconds', ${t.occurredAt}, 'UTC')`),
    check('activities_body_ck', sql`${t.body} is null or length(${t.body}) between 1 and 4000`),
    check('activities_data_ck', sql`jsonb_typeof(${t.data}) = 'object' and octet_length(${t.data}::text) <= 2048`),
    check('activities_idempotency_ck', sql`(${t.idempotencyHash} is null) = (${t.requestHash} is null)`),
    foreignKey({
      name: 'activities_contact_fk',
      columns: [t.agencyId, t.contactId],
      foreignColumns: [contacts.agencyId, contacts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'activities_lead_fk',
      columns: [t.agencyId, t.leadId],
      foreignColumns: [leads.agencyId, leads.id],
    }).onDelete('cascade'),
  ],
);

/**
 * An agency's lead assignment rule (S10-02): `UNASSIGNED` (the default: leads wait in the inbox, the website e-mail
 * goes to the site contact or the admins), `ROUND_ROBIN` over `agent_user_ids` (empty: every active member who works
 * clients), or `OWNER_AGENT` (the target listing's responsible agent; round robin when there is none). A round-robin
 * turn locks the row, so `last_assigned_user_id` advances one lead at a time.
 */
export const leadRoutingSettings = pgTable(
  'lead_routing_settings',
  {
    agencyId: uuid('agency_id')
      .primaryKey()
      .references(() => agencies.id),
    mode: text('mode').notNull().default('UNASSIGNED'),
    agentUserIds: uuid('agent_user_ids').array().notNull().default(sql`'{}'::uuid[]`),
    lastAssignedUserId: uuid('last_assigned_user_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('lead_routing_settings_mode_ck', sql`${t.mode} in ('UNASSIGNED', 'ROUND_ROBIN', 'OWNER_AGENT')`),
    check('lead_routing_settings_agents_ck', sql`cardinality(${t.agentUserIds}) <= 200`),
  ],
);
