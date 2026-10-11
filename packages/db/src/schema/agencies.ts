import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
