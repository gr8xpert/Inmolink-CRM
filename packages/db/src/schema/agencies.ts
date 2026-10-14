import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    /**
     * Regional estate-agent register number where the region requires one (PLAN §3 #3). A company
     * detail staff verify: locked with name and tax id once verified (S1-06, guard migration 0020).
     */
    registerNumber: text('register_number'),
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
    // staff tenants list (S1-09, S2-F1): [where status = ?] order by the keyset time desc, agency_id desc
    // (`keysetOrder`), no sort. No (status, …) index: under app_staff RLS the enum `=` is not leakproof, so a
    // status filter is never an index condition; it filters this ordered scan (5,000 agencies at most).
    index('agencies_created_idx').on(sql`date_trunc('milliseconds', ${t.createdAt}, 'UTC')`, t.id),
    // staff tenant search (S1-F9): `name ilike '%q%'` — a leading wildcard cannot use a btree; trigram GIN (pg_trgm, initdb)
    index('agencies_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

/** How a commission is expressed (PLAN §3 #7): a percentage (basis points) or a fixed amount. */
export const commissionTypeEnum = pgEnum('commission_type', ['PCT', 'FIXED']);

/**
 * Per-agency settings, one row per agency (S1-01; S1-06 adds commission, viewing, white-label and
 * Client Mode options). Other modules read it through the agencies module's cached
 * `getAgencySettings`; every change emits `agencies.settings.changed`, which invalidates that cache.
 * Ranges are CHECK constraints, so a direct table write cannot store what the service would refuse.
 */
export const agencySettings = pgTable(
  'agency_settings',
  {
    agencyId: uuid('agency_id')
      .primaryKey()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /** Locales listings and the website are published in (PLAN §3 #14). */
    enabledLocales: text('enabled_locales').array().notNull(),
    /** Client registration validity (PLAN §3 #8, default 6 months). */
    registrationValidityDays: integer('registration_validity_days').notNull().default(180),
    /**
     * Default commission of new listings (PLAN §3 #7, S1-06-F1): the total, 5 % of the sale price unless
     * the agency changes it. PCT → `default_commission_bp`; FIXED → `default_commission_fixed_cents` + currency.
     */
    defaultCommissionType: commissionTypeEnum('default_commission_type').notNull().default('PCT'),
    defaultCommissionBp: integer('default_commission_bp').default(500),
    defaultCommissionFixedCents: bigint('default_commission_fixed_cents', { mode: 'number' }),
    defaultCommissionCurrency: char('default_commission_currency', { length: 3 }),
    defaultCommissionIncludesVat: boolean('default_commission_includes_vat').notNull().default(false),
    /** The collaborating agent's share of that commission (PLAN §3 #7): 5000 = 50/50, 0–10000. */
    defaultSplitBp: integer('default_split_bp').notNull().default(5000),
    /** Days the agency has to answer a viewing request from another agency (M10). */
    viewingResponseDays: integer('viewing_response_days').notNull().default(3),
    /** White-label (PLAN §3 #6): prefix of listing references shown to clients (`CH-1234`). */
    whiteLabelReferencePrefix: text('white_label_reference_prefix'),
    /** White-label: show "powered by Inmolink" on client-facing outputs. */
    whiteLabelShowPoweredBy: boolean('white_label_show_powered_by').notNull().default(true),
    /** White-label: sender name of client emails; the agency name when null. */
    whiteLabelEmailSenderName: text('white_label_email_sender_name'),
    /** Client Mode (PLAN §3 #56): minimum length of the PIN that ends Client Mode. */
    clientModePinMinLength: integer('client_mode_pin_min_length').notNull().default(4),
    /** Client Mode: wrong PINs before the session must log in again. */
    clientModePinMaxAttempts: integer('client_mode_pin_max_attempts').notNull().default(5),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('agency_settings_locales_ck', sql`cardinality(${t.enabledLocales}) between 1 and 20`),
    check('agency_settings_split_ck', sql`${t.defaultSplitBp} between 0 and 10000`),
    check('agency_settings_registration_days_ck', sql`${t.registrationValidityDays} between 1 and 1095`),
    check('agency_settings_viewing_days_ck', sql`${t.viewingResponseDays} between 1 and 30`),
    check(
      'agency_settings_commission_ck',
      sql`(${t.defaultCommissionType} = 'PCT' and ${t.defaultCommissionBp} between 1 and 10000 and ${t.defaultCommissionFixedCents} is null and ${t.defaultCommissionCurrency} is null) or (${t.defaultCommissionType} = 'FIXED' and ${t.defaultCommissionBp} is null and ${t.defaultCommissionFixedCents} between 1 and 100000000000 and ${t.defaultCommissionCurrency} ~ '^[A-Z]{3}$')`,
    ),
    check(
      'agency_settings_reference_prefix_ck',
      sql`${t.whiteLabelReferencePrefix} is null or ${t.whiteLabelReferencePrefix} ~ '^[A-Z0-9]{1,6}$'`,
    ),
    check(
      'agency_settings_sender_name_ck',
      sql`${t.whiteLabelEmailSenderName} is null or char_length(${t.whiteLabelEmailSenderName}) between 2 and 80`,
    ),
    check('agency_settings_pin_length_ck', sql`${t.clientModePinMinLength} between 4 and 8`),
    check('agency_settings_pin_attempts_ck', sql`${t.clientModePinMaxAttempts} between 3 and 10`),
  ],
);

/**
 * The agency's public face (S1-06): logo, brand colours and contact details for client-facing outputs
 * (websites, selections, PDFs — white-labelled, PLAN §3 #6). One row per agency, created by the first
 * save. Its own `version`: profile edits must not make a pending verification stale (S1-03 binds an
 * approval to `agencies.version`).
 */
export const agencyProfiles = pgTable(
  'agency_profiles',
  {
    agencyId: uuid('agency_id')
      .primaryKey()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /**
     * Logo object. Until the media pipeline (S3-03) it is the uploaded file itself (type checked by magic
     * bytes) in the private bucket under `agency-logos/<agency_id>/` — the CHECK keeps a direct write from
     * pointing it at another agency's or another feature's object.
     */
    logoStorageKey: text('logo_storage_key'),
    logoContentType: text('logo_content_type'),
    logoSizeBytes: integer('logo_size_bytes'),
    logoUpdatedAt: timestamp('logo_updated_at', { withTimezone: true }),
    /** Brand colours, `#rrggbb` (lower case). */
    primaryColor: text('primary_color'),
    accentColor: text('accent_color'),
    /** Public contact details shown to clients. */
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    websiteUrl: text('website_url'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'agency_profiles_logo_ck',
      sql`(${t.logoStorageKey} is null and ${t.logoContentType} is null and ${t.logoSizeBytes} is null) or (starts_with(${t.logoStorageKey}, 'agency-logos/' || ${t.agencyId}::text || '/') and ${t.logoContentType} in ('image/png', 'image/jpeg', 'image/webp') and ${t.logoSizeBytes} > 0)`,
    ),
    check(
      'agency_profiles_colors_ck',
      sql`(${t.primaryColor} is null or ${t.primaryColor} ~ '^#[0-9a-f]{6}$') and (${t.accentColor} is null or ${t.accentColor} ~ '^#[0-9a-f]{6}$')`,
    ),
    check('agency_profiles_website_ck', sql`${t.websiteUrl} is null or ${t.websiteUrl} ~ '^https?://'`),
  ],
);

/** Localized agency texts (tagline, about) per content locale; edited with the profile (S1-06). */
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
  (t) => [
    primaryKey({ columns: [t.agencyId, t.locale] }),
    check(
      'agency_translations_length_ck',
      sql`(${t.tagline} is null or char_length(${t.tagline}) <= 160) and (${t.description} is null or char_length(${t.description}) <= 5000)`,
    ),
  ],
);

/** A verification request moves SUBMITTED → APPROVED | REJECTED once (guard trigger, migration 0011). */
export const verificationRequestStatusEnum = pgEnum('verification_request_status', [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
]);
/** What a verification document proves (PLAN §3 #3): the CIF/NIF, the business, a regional register number. */
export const verificationDocumentKindEnum = pgEnum('verification_document_kind', [
  'TAX_ID',
  'BUSINESS_PROOF',
  'REGISTER',
  'OTHER',
]);

/**
 * Staff verification of an agency (S1-03, PLAN §3 #3). The agency submits its details and documents;
 * staff approve or reject with a reason. The decided row is the record of the decision (reviewer,
 * reason, the details `version` reviewed) and cannot change afterwards. STRICT tenant table; staff
 * reach it through `app_staff` (registry `staff` predicates).
 */
export const agencyVerificationRequests = pgTable(
  'agency_verification_requests',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    status: verificationRequestStatusEnum('status').notNull().default('SUBMITTED'),
    /** `agencies.version` the agency submitted. */
    detailsVersion: integer('details_version').notNull(),
    submittedBy: uuid('submitted_by').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    /** `agencies.version` staff reviewed; an approval is refused if the agency changed since. */
    reviewedVersion: integer('reviewed_version'),
    reviewerUserId: uuid('reviewer_user_id'),
    /** Staff's reason, shown to the agency (and the audit trail). */
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // staff queue: where status = ? order by submitted_at, id (keyset)
    index('agency_verification_requests_queue_idx').on(t.status, t.submittedAt, t.id),
    // FK + the agency's latest request: where agency_id = ? order by submitted_at desc
    index('agency_verification_requests_agency_idx').on(t.agencyId, t.submittedAt),
    // one open request per agency
    uniqueIndex('agency_verification_requests_open_uq').on(t.agencyId).where(sql`status = 'SUBMITTED'`),
  ],
);

/**
 * Files proving the company (S1-03), in the private bucket (`S3_BUCKET_PRIVATE`) under `storage_key`.
 * Never served publicly: staff read them through short signed URLs. Unattached (`request_id` null)
 * until the agency submits; attached documents cannot change or be deleted by the agency.
 */
export const agencyVerificationDocuments = pgTable(
  'agency_verification_documents',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').references(() => agencyVerificationRequests.id),
    kind: verificationDocumentKindEnum('kind').notNull(),
    /** Display name as uploaded (sanitized). */
    fileName: text('file_name').notNull(),
    /** Detected from the file's magic bytes, not the client's header. */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK + the agency's documents: where agency_id = ? order by created_at, id
    index('agency_verification_documents_agency_idx').on(t.agencyId, t.createdAt, t.id),
    // FK + a request's documents (staff detail): where request_id = ?
    index('agency_verification_documents_request_idx').on(t.requestId).where(sql`request_id is not null`),
    uniqueIndex('agency_verification_documents_key_uq').on(t.storageKey),
  ],
);

/**
 * Directory of agencies other verified agencies may find (S1-07): name and kind only, one row per
 * agency that has ever been VERIFIED; `listed` while it is VERIFIED. Kept in step with `agencies` by a
 * trigger in the transaction that changes its status, name or kind (migration 0022), never written by tenants.
 * NETWORK_READ: verified agencies read the listed rows (to find an agency to add as preferred, and
 * to show partner names); the owner sees its own row.
 *
 * No search index: ≤ 5,000 agencies (PLAN §1), a substring scan of this narrow table is well under the
 * 10k-row Seq Scan budget. Add a `pg_trgm` index if the directory grows past it.
 */
export const agencyDirectory = pgTable('agency_directory', {
  agencyId: uuid('agency_id')
    .primaryKey()
    .references(() => agencies.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: agencyKindEnum('kind').notNull(),
  /** The agency is VERIFIED now. Unlisted agencies are invisible to others and stop receiving PREFERRED shares. */
  listed: boolean('listed').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Preferred agencies (S1-07, PLAN §3 #57): agency `agency_id` trusts `preferred_agency_id` with listings
 * shared to PREFERRED only. The relationship alone — no private columns: NETWORK_READ lets the preferred
 * agency read the rows that name it (that is what `app_preferring_agencies()` returns to listing
 * policies). The owner's note lives in `preferred_agency_notes` (STRICT).
 */
export const preferredAgencies = pgTable(
  'preferred_agencies',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    preferredAgencyId: uuid('preferred_agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agencyId, t.preferredAgencyId] }),
    // the owner's list: where agency_id = ? order by created_at, preferred_agency_id (keyset)
    index('preferred_agencies_list_idx').on(t.agencyId, t.createdAt, t.preferredAgencyId),
    // FK + app_preferring_agencies(): where preferred_agency_id = app_agency()
    index('preferred_agencies_preferred_idx').on(t.preferredAgencyId, t.agencyId),
    check('preferred_agencies_not_self_ck', sql`${t.agencyId} <> ${t.preferredAgencyId}`),
  ],
);

/**
 * The owner's private side of a preferred agency (S1-07): its internal note, the partner's name when
 * it was added (shown if the partner later leaves the directory), and who added it. STRICT — never
 * visible to the preferred agency. Deleted with the relationship.
 */
export const preferredAgencyNotes = pgTable(
  'preferred_agency_notes',
  {
    agencyId: uuid('agency_id').notNull(),
    preferredAgencyId: uuid('preferred_agency_id').notNull(),
    nameWhenAdded: text('name_when_added').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agencyId, t.preferredAgencyId] }),
    foreignKey({
      name: 'preferred_agency_notes_relationship_fk',
      columns: [t.agencyId, t.preferredAgencyId],
      foreignColumns: [preferredAgencies.agencyId, preferredAgencies.preferredAgencyId],
    }).onDelete('cascade'),
    check('preferred_agency_notes_note_ck', sql`${t.note} is null or char_length(${t.note}) between 1 and 1000`),
  ],
);
