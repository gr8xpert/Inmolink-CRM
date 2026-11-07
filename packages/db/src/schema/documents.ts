/**
 * Tables owned by the documents module (PATTERNS §2). Only `packages/core/src/modules/documents` imports this file
 * (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
