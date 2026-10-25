/**
 * Tables owned by the support module (PATTERNS §2). Only `packages/core/src/modules/support` imports
 * this file (`pnpm check:boundaries`). Register each table in `../tenancy/registry.ts`, then run
 * `pnpm db:generate && pnpm db:migrate && pnpm db:rls`.
 *
 * S13-05 (PLAN §7 M21): in-app support tickets, agency → staff. STRICT tenant tables; staff reach every agency's
 * rows through `app_staff` (registry `staff` predicates). Internal notes live in their own table that no tenant role
 * has any grant on (`support_ticket_notes`, registry `noUserRead`): an agency cannot read one, whatever the query.
 * Messages and attachments reference their ticket by `(agency_id, ticket_id)`, so a row can never name another
 * agency's ticket.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

/** OPEN: waiting for staff · PENDING: waiting for the agency · RESOLVED: done (an agency reply reopens it). */
export const supportTicketStatusEnum = pgEnum('support_ticket_status', ['OPEN', 'PENDING', 'RESOLVED']);
export const supportTicketPriorityEnum = pgEnum('support_ticket_priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const supportTicketCategoryEnum = pgEnum('support_ticket_category', [
  'ACCOUNT',
  'BILLING',
  'LISTINGS',
  'IMPORTS',
  'WEBSITE',
  'INTEGRATIONS',
  'BUG',
  'OTHER',
]);
/** Who wrote a message: a member of the agency, or a support agent. */
export const supportMessageAuthorEnum = pgEnum('support_message_author', ['AGENCY', 'STAFF']);

/** One support request of an agency. Every member of the agency reads its tickets; staff read and triage all. */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    category: supportTicketCategoryEnum('category').notNull(),
    priority: supportTicketPriorityEnum('priority').notNull().default('NORMAL'),
    status: supportTicketStatusEnum('status').notNull().default('OPEN'),
    /** The member who opened it (the staff reply e-mail goes to them). */
    createdBy: uuid('created_by').notNull(),
    /** The staff member working on it; null: unassigned. Only staff change it. */
    assigneeUserId: uuid('assignee_user_id'),
    /** Last message visible to the agency (internal notes do not move it); the staff queue waits on it. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('support_tickets_subject_len', sql`char_length(${t.subject}) between 1 and 200`),
    // the target of the messages' and attachments' (agency_id, ticket_id) foreign keys
    unique('support_tickets_agency_id_uq').on(t.agencyId, t.id),
    // the agency's tickets: where agency_id = ? order by created_at desc, id desc (keyset)
    index('support_tickets_agency_idx').on(t.agencyId, t.createdAt, t.id),
    // staff queue, oldest waiting first: where status = ? order by last_message_at, id (keyset)
    index('support_tickets_queue_idx').on(t.status, t.lastMessageAt, t.id),
  ],
);

/**
 * The conversation of a ticket, as the agency sees it — a trail: appended, never changed or removed by a request.
 * `author_kind` AGENCY (a member, who writes only as themselves) or STAFF (a support agent). `author_name` is a
 * snapshot for display. Internal notes are never here.
 */
export const supportTicketMessages = pgTable(
  'support_ticket_messages',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').notNull(),
    authorKind: supportMessageAuthorEnum('author_kind').notNull(),
    authorUserId: uuid('author_user_id').notNull(),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('support_ticket_messages_body_len', sql`char_length(${t.body}) between 1 and 10000`),
    foreignKey({
      name: 'support_ticket_messages_ticket_fk',
      columns: [t.agencyId, t.ticketId],
      foreignColumns: [supportTickets.agencyId, supportTickets.id],
    }).onDelete('cascade'),
    // FK + a ticket's thread: where agency_id = ? and ticket_id = ? and (created_at, id) < (?, ?)
    // order by created_at desc, id desc
    index('support_ticket_messages_ticket_idx').on(t.agencyId, t.ticketId, t.createdAt, t.id),
  ],
);

/**
 * Files an agency attaches to a ticket (at most 5 × 10 MB), in the private bucket under `storage_key`
 * (`support/<agency>/<id>`). Read through short signed URLs only; never changed or removed by a request.
 */
export const supportTicketAttachments = pgTable(
  'support_ticket_attachments',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').notNull(),
    /** Display name as uploaded (validated), ending in the detected type's extension. */
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
    foreignKey({
      name: 'support_ticket_attachments_ticket_fk',
      columns: [t.agencyId, t.ticketId],
      foreignColumns: [supportTickets.agencyId, supportTickets.id],
    }).onDelete('cascade'),
    // FK + a ticket's files: where agency_id = ? and ticket_id = ? order by created_at, id
    index('support_ticket_attachments_ticket_idx').on(t.agencyId, t.ticketId, t.createdAt, t.id),
    uniqueIndex('support_ticket_attachments_key_uq').on(t.storageKey),
  ],
);

/**
 * Staff-only internal notes on a ticket (S13-05). Platform data with no `agency_id`: no tenant role (`app_user`,
 * `app_public`, …) has any grant on it, so no agency query path can ever return one. Staff read every note; support
 * agents and super admins append them (registry `staffWrite`). Scoped to its agency through the ticket.
 */
export const supportTicketNotes = pgTable(
  'support_ticket_notes',
  {
    id: uuid('id').primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').notNull(),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('support_ticket_notes_body_len', sql`char_length(${t.body}) between 1 and 10000`),
    // FK + a ticket's notes: where ticket_id = ? order by created_at, id
    index('support_ticket_notes_ticket_idx').on(t.ticketId, t.createdAt, t.id),
  ],
);
