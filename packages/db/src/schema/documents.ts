/**
 * Tables owned by the documents module (PATTERNS §2). Only `packages/core/src/modules/documents` imports this file
 * (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * R2-05a, the forms library (PLAN §7 M13): a listing agreement, reservation, viewing sheet, offer or collaboration
 * agreement generated for the agency — branded, in the client's language, merged from data (`data`: the parties,
 * property, prices and commission as read when it was made, never written by AI). A member creates one (`PENDING`, as
 * themself); the `pdf` pool renders it once into the private bucket and records the PDF's SHA-256 (`READY`) — the hash
 * a signature (R2-05b) is made over. Members never change or remove a row: the render is the worker's, removal the
 * erasure's.
 */
export const formDocuments = pgTable(
  'form_documents',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    /** `LISTING_AGREEMENT`, `RESERVATION`, `VIEWING_SHEET`, `OFFER` or `COLLABORATION_AGREEMENT`. */
    template: text('template').notNull(),
    /** The document's language (a content locale). */
    locale: text('locale').notNull(),
    /** Layout and clause version the document was made with. */
    templateVersion: integer('template_version').notNull(),
    /** `PENDING` → `READY` (or `FAILED`), by the render job. */
    status: text('status').notNull().default('PENDING'),
    /** The (first) property, the client and the deal it is about — for lists and erasure; the content is in `data`. */
    listingId: uuid('listing_id'),
    contactId: uuid('contact_id'),
    dealId: uuid('deal_id'),
    /** What the list shows: reference and party, as made. */
    label: text('label').notNull(),
    /** The merged values (documents `FormData`, versioned). */
    data: jsonb('data').notNull(),
    /** SHA-256 (hex) of the stored PDF's bytes, once rendered. */
    sha256: text('sha256'),
    sizeBytes: integer('size_bytes'),
    renderedAt: timestamp('rendered_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').notNull(),
    idempotencyHash: text('idempotency_hash'),
    requestHash: text('request_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the agency's forms, newest first: where agency_id = ? order by created_at desc, id desc
    index('form_documents_list_idx').on(t.agencyId, t.createdAt, t.id),
    // a contact's forms (list filter, erasure): where agency_id = ? and contact_id = ? order by created_at desc, id desc
    index('form_documents_contact_idx')
      .on(t.agencyId, t.contactId, t.createdAt, t.id)
      .where(sql`${t.contactId} is not null`),
    // a listing's forms: where agency_id = ? and listing_id = ? order by created_at desc, id desc
    index('form_documents_listing_idx')
      .on(t.agencyId, t.listingId, t.createdAt, t.id)
      .where(sql`${t.listingId} is not null`),
    // a deal's forms: where agency_id = ? and deal_id = ? order by created_at desc, id desc
    index('form_documents_deal_idx').on(t.agencyId, t.dealId, t.createdAt, t.id).where(sql`${t.dealId} is not null`),
    // POST replay: where agency_id = ? and idempotency_hash = ?
    uniqueIndex('form_documents_idempotency_uq')
      .on(t.agencyId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
    check(
      'form_documents_template_ck',
      sql`${t.template} in ('LISTING_AGREEMENT', 'RESERVATION', 'VIEWING_SHEET', 'OFFER', 'COLLABORATION_AGREEMENT')`,
    ),
    check('form_documents_status_ck', sql`${t.status} in ('PENDING', 'READY', 'FAILED')`),
    check('form_documents_locale_ck', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('form_documents_label_ck', sql`char_length(${t.label}) between 1 and 300`),
    check('form_documents_data_ck', sql`jsonb_typeof(${t.data}) = 'object' and pg_column_size(${t.data}) <= 65536`),
    check('form_documents_sha256_ck', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'form_documents_ready_ck',
      sql`(${t.status} = 'READY') = (${t.sha256} is not null and ${t.sizeBytes} is not null and ${t.renderedAt} is not null)`,
    ),
  ],
);

/*
 * R2-05b, simple electronic signature (PLAN §7 M13; H17 open). A member asks the people who must sign a READY form to
 * sign it (`signature_requests`, over the form's SHA-256 as it was then; one signer row each). Each signer gets a
 * signed link to the public signing page, asks for a one-time code by e-mail, and signs with the code (typed name or
 * drawn signature). What a signer does on the page is appended by the public pages as `app_intake`
 * (`signature_events`: the code sent, a wrong code, the signature with its IP and user agent) — never updated; the
 * worker applies a signature to its signer and, once all have signed, seals the signed PDF (the original's pages and
 * an audit-trail page) and records its SHA-256 (`COMPLETED`). Members create requests and signers, never change them.
 */
export const signatureRequests = pgTable(
  'signature_requests',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    formId: uuid('form_id')
      .notNull()
      .references(() => formDocuments.id, { onDelete: 'cascade' }),
    /** The e-signature provider (`@inmolink/platform/esign`): `builtin` (simple electronic signature). */
    provider: text('provider').notNull(),
    /** `OPEN` → `SIGNED` (everyone signed) → `COMPLETED` (signed PDF stored), or `CANCELLED` / `FAILED`. */
    status: text('status').notNull().default('OPEN'),
    /** Signers sign one after another (by `position`); otherwise in any order. */
    ordered: boolean('ordered').notNull().default(false),
    /** The SHA-256 of the form's PDF the signers are shown and sign (the form's own, copied when asked). */
    documentSha256: text('document_sha256').notNull(),
    /** The agency's note to the signers (in the invitation e-mail). */
    message: text('message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    allSignedAt: timestamp('all_signed_at', { withTimezone: true }),
    /** The signed PDF: its SHA-256 and size, and when it was stored. */
    signedSha256: text('signed_sha256'),
    signedSizeBytes: integer('signed_size_bytes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    idempotencyHash: text('idempotency_hash'),
    requestHash: text('request_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // a form's requests, newest first: where agency_id = ? and form_id = ? order by created_at desc, id desc
    index('signature_requests_form_idx').on(t.agencyId, t.formId, t.createdAt, t.id),
    // the form's FK (the cascade of a form's erasure): where form_id = ?
    index('signature_requests_form_fk_idx').on(t.formId),
    // POST replay: where agency_id = ? and idempotency_hash = ?
    uniqueIndex('signature_requests_idempotency_uq')
      .on(t.agencyId, t.idempotencyHash)
      .where(sql`${t.idempotencyHash} is not null`),
    check('signature_requests_status_ck', sql`${t.status} in ('OPEN', 'SIGNED', 'COMPLETED', 'CANCELLED', 'FAILED')`),
    check('signature_requests_provider_ck', sql`${t.provider} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    check('signature_requests_sha256_ck', sql`${t.documentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'signature_requests_signed_sha256_ck',
      sql`${t.signedSha256} is null or ${t.signedSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('signature_requests_message_ck', sql`${t.message} is null or char_length(${t.message}) between 1 and 1000`),
    check(
      'signature_requests_completed_ck',
      sql`(${t.status} = 'COMPLETED') = (${t.signedSha256} is not null and ${t.signedSizeBytes} is not null and ${t.completedAt} is not null)`,
    ),
    check(
      'signature_requests_signed_ck',
      sql`${t.status} not in ('SIGNED', 'COMPLETED') or ${t.allSignedAt} is not null`,
    ),
    check('signature_requests_cancelled_ck', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} is not null)`),
  ],
);

/** The people asked to sign (R2-05b): name, e-mail and the role they sign as; the worker records the signature. */
export const signatureSigners = pgTable(
  'signature_signers',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => signatureRequests.id, { onDelete: 'cascade' }),
    /** 1-based; the signing order of an `ordered` request. */
    position: integer('position').notNull(),
    /** The signature block they sign (documents `FORM_SIGNERS`: `buyer`, `seller`, `agency`, `ownerAgency`, …). */
    role: text('role').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** The language of their e-mails and page (a UI language). */
    locale: text('locale').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    /** Applied by the worker from the signer's `SIGNED` event (its time, never the worker's). */
    signedAt: timestamp('signed_at', { withTimezone: true }),
    signatureEventId: uuid('signature_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // a request's signers in order: where request_id = ? order by position (also the FK's index)
    uniqueIndex('signature_signers_request_position_uq').on(t.requestId, t.position),
    check('signature_signers_position_ck', sql`${t.position} between 1 and 10`),
    check('signature_signers_role_ck', sql`${t.role} ~ '^[a-zA-Z]{1,32}$'`),
    check('signature_signers_name_ck', sql`char_length(${t.name}) between 1 and 200`),
    check('signature_signers_email_ck', sql`char_length(${t.email}) between 3 and 254 and ${t.email} like '%@%'`),
    check('signature_signers_locale_ck', sql`${t.locale} ~ '^[a-z]{2}$'`),
    check('signature_signers_signed_ck', sql`(${t.signedAt} is null) = (${t.signatureEventId} is null)`),
  ],
);

/**
 * What a signer did on the signing page (R2-05b), appended by the public pages as `app_intake` and never changed: a
 * one-time code sent (`OTP_SENT`: the code is derived from this row's id with a keyed MAC — never stored), a wrong code
 * (`OTP_FAILED`) and the signature (`SIGNED`, at most one per signer: the name, the drawn image if any, the hash shown,
 * the consent, the IP and user agent). The audit trail of the signed PDF.
 */
export const signatureEvents = pgTable(
  'signature_events',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id').notNull(),
    signerId: uuid('signer_id')
      .notNull()
      .references(() => signatureSigners.id, { onDelete: 'cascade' }),
    /** `OTP_SENT`, `OTP_FAILED` or `SIGNED`. */
    kind: text('kind').notNull(),
    /** The code a wrong guess or the signature was checked against (an `OTP_SENT` row of the signer). */
    otpId: uuid('otp_id'),
    /** `OTP_SENT`: when the code stops working. */
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** `SIGNED`: `TYPED` or `DRAWN`; the name as typed; the drawn image (PNG, base64); what was signed and agreed. */
    signatureKind: text('signature_kind'),
    signatureText: text('signature_text'),
    signaturePng: text('signature_png'),
    documentSha256: text('document_sha256'),
    consented: boolean('consented'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // a signer's codes and attempts, newest first (the public pages, which read no agency_id): where signer_id = ?
    // and kind = ? order by created_at desc; also the FK's index (the cascade of a signer's removal)
    index('signature_events_signer_idx').on(t.signerId, t.createdAt),
    // one signature per signer (a second submission is refused by the database)
    uniqueIndex('signature_events_signed_uq').on(t.signerId).where(sql`${t.kind} = 'SIGNED'`),
    check('signature_events_kind_ck', sql`${t.kind} in ('OTP_SENT', 'OTP_FAILED', 'SIGNED')`),
    check('signature_events_otp_sent_ck', sql`(${t.kind} = 'OTP_SENT') = (${t.otpExpiresAt} is not null)`),
    check('signature_events_otp_ck', sql`(${t.kind} = 'OTP_SENT') = (${t.otpId} is null)`),
    check('signature_events_ip_ck', sql`${t.ip} is null or char_length(${t.ip}) <= 64`),
    check('signature_events_ua_ck', sql`${t.userAgent} is null or char_length(${t.userAgent}) <= 512`),
    check(
      'signature_events_signed_ck',
      sql`(${t.kind} = 'SIGNED') = (${t.signatureKind} is not null and ${t.signatureText} is not null and ${t.documentSha256} is not null and ${t.consented} is true)`,
    ),
    check(
      'signature_events_signature_ck',
      sql`${t.signatureKind} is null or (${t.signatureKind} = 'TYPED' and ${t.signaturePng} is null) or (${t.signatureKind} = 'DRAWN' and ${t.signaturePng} is not null)`,
    ),
    check(
      'signature_events_text_ck',
      sql`${t.signatureText} is null or char_length(${t.signatureText}) between 1 and 200`,
    ),
    check(
      'signature_events_png_ck',
      sql`${t.signaturePng} is null or (char_length(${t.signaturePng}) <= 90000 and ${t.signaturePng} ~ '^[A-Za-z0-9+/]+={0,2}$')`,
    ),
    check('signature_events_sha256_ck', sql`${t.documentSha256} is null or ${t.documentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
