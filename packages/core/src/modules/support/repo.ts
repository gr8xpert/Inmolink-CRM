/**
 * support queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/support` — other modules' tables fail `pnpm check:boundaries`.
 */

import { SUPPORT_ATTACHMENT_MAX_COUNT } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import {
  supportTicketAttachments,
  supportTicketMessages,
  supportTicketNotes,
  supportTickets,
} from '@inmolink/db/schema/support';
import { and, asc, count, eq, gte } from 'drizzle-orm';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw, keysetStamp } from '../../pagination';

export type TicketStatus = (typeof supportTickets.$inferSelect)['status'];
export type TicketPriority = (typeof supportTickets.$inferSelect)['priority'];
export type TicketCategory = (typeof supportTickets.$inferSelect)['category'];

const ticketColumns = {
  id: supportTickets.id,
  agencyId: supportTickets.agencyId,
  subject: supportTickets.subject,
  category: supportTickets.category,
  priority: supportTickets.priority,
  status: supportTickets.status,
  createdBy: supportTickets.createdBy,
  assigneeUserId: supportTickets.assigneeUserId,
  lastMessageAt: supportTickets.lastMessageAt,
  resolvedAt: supportTickets.resolvedAt,
  createdAt: supportTickets.createdAt,
};

export async function insertTicket(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    subject: string;
    category: TicketCategory;
    priority: TicketPriority;
    createdBy: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(supportTickets).values({
    id: row.id,
    agencyId: row.agencyId,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    createdBy: row.createdBy,
    lastMessageAt: row.now,
    createdAt: row.now,
    updatedAt: row.now,
  });
}

/**
 * One ticket by id. The agency path passes its `agencyId` (RLS pins it too); the staff path reads any agency's.
 * `forUpdate` serializes writes on the ticket (replies, triage, the attachment cap).
 */
export async function getTicket(tx: Tx, id: string, options: { agencyId?: string; forUpdate?: boolean } = {}) {
  const where = options.agencyId
    ? and(eq(supportTickets.id, id), eq(supportTickets.agencyId, options.agencyId))
    : eq(supportTickets.id, id);
  const query = tx.select(ticketColumns).from(supportTickets).where(where);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}
export type TicketRow = NonNullable<Awaited<ReturnType<typeof getTicket>>>;

export async function updateTicket(
  tx: Tx,
  id: string,
  patch: Partial<{
    status: TicketStatus;
    priority: TicketPriority;
    assigneeUserId: string | null;
    lastMessageAt: Date;
    resolvedAt: Date | null;
  }>,
  now: Date,
): Promise<void> {
  await tx
    .update(supportTickets)
    .set({ ...patch, updatedAt: now })
    .where(eq(supportTickets.id, id));
}

/** The agency's tickets, newest first (keyset on the raw `created_at`, index `support_tickets_agency_idx`). */
export async function listAgencyTickets(
  tx: Tx,
  agencyId: string,
  q: { status?: TicketStatus; limit: number; cursor?: KeysetCursor },
) {
  return tx
    .select({ ...ticketColumns, atUs: keysetStamp(supportTickets.createdAt) })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.agencyId, agencyId),
        q.status ? eq(supportTickets.status, q.status) : undefined,
        keysetAfterRaw(supportTickets.createdAt, supportTickets.id, q.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(supportTickets.createdAt, supportTickets.id, 'desc'))
    .limit(q.limit + 1);
}

/**
 * Staff queue: one status, the longest waiting first — by the last message the agency can see (keyset on the raw
 * `last_message_at`, index `support_tickets_queue_idx`). A ticket that gets a new message while staff page moves to
 * the end of the queue, where it belongs.
 */
export async function listQueue(tx: Tx, q: { status: TicketStatus; limit: number; cursor?: KeysetCursor }) {
  return tx
    .select({ ...ticketColumns, atUs: keysetStamp(supportTickets.lastMessageAt) })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, q.status),
        keysetAfterRaw(supportTickets.lastMessageAt, supportTickets.id, q.cursor, 'asc'),
      ),
    )
    .orderBy(...keysetOrderRaw(supportTickets.lastMessageAt, supportTickets.id, 'asc'))
    .limit(q.limit + 1);
}

export async function insertMessage(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    ticketId: string;
    authorKind: 'AGENCY' | 'STAFF';
    authorUserId: string;
    authorName: string;
    body: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(supportTicketMessages).values({
    id: row.id,
    agencyId: row.agencyId,
    ticketId: row.ticketId,
    authorKind: row.authorKind,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.now,
  });
}

const messageColumns = {
  id: supportTicketMessages.id,
  authorKind: supportTicketMessages.authorKind,
  authorUserId: supportTicketMessages.authorUserId,
  authorName: supportTicketMessages.authorName,
  body: supportTicketMessages.body,
  createdAt: supportTicketMessages.createdAt,
};

/**
 * A page of a ticket's messages, newest first: the `limit` messages before `before` (none: the latest), plus one to
 * tell whether older ones exist (keyset on the raw `created_at`, index `support_ticket_messages_ticket_idx`).
 */
export async function listMessages(
  tx: Tx,
  agencyId: string,
  ticketId: string,
  q: { limit: number; before?: KeysetCursor },
) {
  return tx
    .select({ ...messageColumns, atUs: keysetStamp(supportTicketMessages.createdAt) })
    .from(supportTicketMessages)
    .where(
      and(
        eq(supportTicketMessages.agencyId, agencyId),
        eq(supportTicketMessages.ticketId, ticketId),
        keysetAfterRaw(supportTicketMessages.createdAt, supportTicketMessages.id, q.before, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(supportTicketMessages.createdAt, supportTicketMessages.id, 'desc'))
    .limit(q.limit + 1);
}

/** Staff only (`app_staff`; no tenant role has a grant): a staff internal note. */
export async function insertNote(
  tx: Tx,
  row: { id: string; ticketId: string; authorUserId: string; authorName: string; body: string; now: Date },
): Promise<void> {
  await tx.insert(supportTicketNotes).values({
    id: row.id,
    ticketId: row.ticketId,
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.now,
  });
}

/**
 * Staff only: the internal notes in the window of a page of messages — after `from` (the page's oldest message, when
 * older pages exist) and before `before` (the page's cursor) — at most `limit`, the latest of them, newest first.
 */
export async function listNotes(tx: Tx, ticketId: string, q: { limit: number; from?: Date; before?: KeysetCursor }) {
  return tx
    .select({
      id: supportTicketNotes.id,
      authorUserId: supportTicketNotes.authorUserId,
      authorName: supportTicketNotes.authorName,
      body: supportTicketNotes.body,
      createdAt: supportTicketNotes.createdAt,
    })
    .from(supportTicketNotes)
    .where(
      and(
        eq(supportTicketNotes.ticketId, ticketId),
        q.from ? gte(supportTicketNotes.createdAt, q.from) : undefined,
        keysetAfterRaw(supportTicketNotes.createdAt, supportTicketNotes.id, q.before, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(supportTicketNotes.createdAt, supportTicketNotes.id, 'desc'))
    .limit(q.limit);
}

/** For the e-mail job (`withSystem`): the message and its ticket. */
export async function getMessageForEmail(tx: Tx, agencyId: string, messageId: string) {
  const [row] = await tx
    .select({
      ticketId: supportTickets.id,
      subject: supportTickets.subject,
      category: supportTickets.category,
      priority: supportTickets.priority,
      createdBy: supportTickets.createdBy,
      authorKind: supportTicketMessages.authorKind,
    })
    .from(supportTicketMessages)
    .innerJoin(supportTickets, eq(supportTickets.id, supportTicketMessages.ticketId))
    .where(and(eq(supportTicketMessages.agencyId, agencyId), eq(supportTicketMessages.id, messageId)));
  return row ?? null;
}

const attachmentColumns = {
  id: supportTicketAttachments.id,
  fileName: supportTicketAttachments.fileName,
  contentType: supportTicketAttachments.contentType,
  sizeBytes: supportTicketAttachments.sizeBytes,
  storageKey: supportTicketAttachments.storageKey,
  createdAt: supportTicketAttachments.createdAt,
};

/** A ticket's files (at most `SUPPORT_ATTACHMENT_MAX_COUNT`), oldest first. */
export async function listAttachments(tx: Tx, agencyId: string, ticketId: string) {
  return tx
    .select(attachmentColumns)
    .from(supportTicketAttachments)
    .where(and(eq(supportTicketAttachments.agencyId, agencyId), eq(supportTicketAttachments.ticketId, ticketId)))
    .orderBy(asc(supportTicketAttachments.createdAt), asc(supportTicketAttachments.id))
    .limit(SUPPORT_ATTACHMENT_MAX_COUNT);
}

export async function countAttachments(tx: Tx, agencyId: string, ticketId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(supportTicketAttachments)
    .where(and(eq(supportTicketAttachments.agencyId, agencyId), eq(supportTicketAttachments.ticketId, ticketId)));
  return row?.n ?? 0;
}

export async function findAttachmentBySha(tx: Tx, agencyId: string, ticketId: string, sha256: string) {
  const [row] = await tx
    .select(attachmentColumns)
    .from(supportTicketAttachments)
    .where(
      and(
        eq(supportTicketAttachments.agencyId, agencyId),
        eq(supportTicketAttachments.ticketId, ticketId),
        eq(supportTicketAttachments.sha256, sha256),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertAttachment(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    ticketId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
    uploadedBy: string;
    now: Date;
  },
) {
  const [inserted] = await tx
    .insert(supportTicketAttachments)
    .values({
      id: row.id,
      agencyId: row.agencyId,
      ticketId: row.ticketId,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      storageKey: row.storageKey,
      uploadedBy: row.uploadedBy,
      createdAt: row.now,
    })
    .returning(attachmentColumns);
  if (!inserted) throw new Error('support: attachment insert returned no row');
  return inserted;
}

export async function getAttachment(tx: Tx, agencyId: string, ticketId: string, attachmentId: string) {
  const [row] = await tx
    .select(attachmentColumns)
    .from(supportTicketAttachments)
    .where(
      and(
        eq(supportTicketAttachments.agencyId, agencyId),
        eq(supportTicketAttachments.ticketId, ticketId),
        eq(supportTicketAttachments.id, attachmentId),
      ),
    );
  return row ?? null;
}

export type AttachmentRow = Awaited<ReturnType<typeof listAttachments>>[number];
