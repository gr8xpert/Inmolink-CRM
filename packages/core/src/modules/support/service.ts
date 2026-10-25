/**
 * support use cases (S13-05, PLAN §7 M21; PATTERNS §7). A member opens a ticket and talks to staff on it; staff work
 * the queue, reply, keep internal notes and triage. Internal notes never reach an agency: they live in their own table
 * (`support_ticket_notes`) that no tenant role has any grant on, the agency read paths never query it, the agency DTO
 * has no field for them, and they emit no event (so no e-mail can carry one). E-mails go out from a worker job.
 * Every staff write (reply, note, triage) is audited in its transaction (`staff.support.*`, ids and enums only).
 */
import { createHash } from 'node:crypto';
import {
  type CreateSupportTicketBody,
  type PostSupportMessageBody,
  type SignedUrlDto,
  type StaffPostSupportMessageBody,
  type StaffSupportMessageDto,
  type StaffSupportQueuePage,
  type StaffSupportQueueQuery,
  type StaffSupportTicketDto,
  type StaffUpdateSupportTicketBody,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MAX_COUNT,
  SUPPORT_ATTACHMENT_TYPES,
  SUPPORT_THREAD_LIMIT,
  type SupportAttachmentDto,
  type SupportTicketDto,
  type SupportTicketListQuery,
  type SupportTicketPage,
  type SupportTicketQuery,
  type SupportTicketSummaryDto,
  type UploadSupportAttachmentQuery,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, storage } from '@inmolink/platform/storage';
import { type Ctx, type CtxRunner, memberUserId, type StaffCtx } from '../../context';
import { decodeCursor, encodeCursor, type KeysetCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as identity from '../identity';
import { supportEvents } from './events';
import { assertCan, assertStaffCan } from './policy';
import * as repo from './repo';

/** Signed attachment links live this long: enough to open the file, too short to share around. */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/**
 * The longest stem a stored file name keeps before the detected extension is appended: with the dot and a 4-letter
 * extension it stays within the 120 characters `DocumentFileName` allows.
 */
const FILE_NAME_STEM_MAX = 115;

const ALLOWED_TYPES: readonly string[] = SUPPORT_ATTACHMENT_TYPES;

const storageKeyOf = (agencyId: string, id: string) => `support/${agencyId}/${id}`;

function toSummary(t: repo.TicketRow): SupportTicketSummaryDto {
  return {
    id: t.id,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    lastMessageAt: t.lastMessageAt.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
  };
}

function toAttachmentDto(a: repo.AttachmentRow): SupportAttachmentDto {
  return {
    id: a.id,
    fileName: a.fileName,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    createdAt: a.createdAt.toISOString(),
  };
}

/** The display name ends in the extension of the type we detected (a renamed `.exe` stays a PDF). */
function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name.slice(0, FILE_NAME_STEM_MAX)}.${extension}`;
}

/**
 * One page of a ticket's messages (the latest, or the one before `before`), oldest first, and the cursor of the page
 * before it (null: the page starts the conversation).
 */
async function messagePage(tx: Tx, agencyId: string, ticketId: string, before: KeysetCursor | undefined) {
  const rows = await repo.listMessages(tx, agencyId, ticketId, { limit: SUPPORT_THREAD_LIMIT, before });
  const page = rows.slice(0, SUPPORT_THREAD_LIMIT);
  const oldest = page.at(-1);
  const olderCursor =
    rows.length > SUPPORT_THREAD_LIMIT && oldest
      ? encodeCursor({ at: oldest.createdAt, id: oldest.id, atUs: oldest.atUs })
      : null;
  return { messages: page.reverse(), olderCursor, oldest: olderCursor ? oldest : undefined };
}

// ── Agency ─────────────────────────────────────────────────────────────────────────────────────

/** The agency's view of one ticket: no internal note, no staff member's name (4 indexed queries). */
async function loadTicketDto(ctx: Ctx, id: string, before?: KeysetCursor): Promise<SupportTicketDto> {
  const agencyId = ctx.tenant.agencyId;
  const ticket = await repo.getTicket(ctx.tx, id, { agencyId });
  if (!ticket) throw new AppError('NOT_FOUND');
  const { messages, olderCursor } = await messagePage(ctx.tx, agencyId, id, before);
  const attachments = await repo.listAttachments(ctx.tx, agencyId, id);
  return {
    ...toSummary(ticket),
    messages: messages.map((m) => ({
      id: m.id,
      author: m.authorKind,
      authorName: m.authorKind === 'AGENCY' ? m.authorName : null,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
    olderMessagesCursor: olderCursor,
    attachments: attachments.map(toAttachmentDto),
  };
}

async function memberName(ctx: Ctx, userId: string): Promise<string> {
  return (await identity.memberNames(ctx, [userId])).get(userId) ?? '';
}

/** Opens a ticket with its first message; the support inbox is told by the worker (`support.message.posted`). */
export async function createTicket(ctx: Ctx, input: CreateSupportTicketBody): Promise<SupportTicketDto> {
  assertCan(ctx, 'support.write');
  const userId = memberUserId(ctx);
  const agencyId = ctx.tenant.agencyId;
  const now = clock.now();
  const ticketId = newId();
  const messageId = newId();
  await repo.insertTicket(ctx.tx, {
    id: ticketId,
    agencyId,
    subject: input.subject,
    category: input.category,
    priority: input.priority,
    createdBy: userId,
    now,
  });
  await repo.insertMessage(ctx.tx, {
    id: messageId,
    agencyId,
    ticketId,
    authorKind: 'AGENCY',
    authorUserId: userId,
    authorName: await memberName(ctx, userId),
    body: input.body,
    now,
  });
  await emit(ctx.tx, supportEvents.messagePosted({ ticketId, messageId, author: 'AGENCY', isNew: true }), {
    agencyId,
  });
  return loadTicketDto(ctx, ticketId);
}

/** The agency's tickets, newest first (keyset). */
export async function listTickets(ctx: Ctx, q: SupportTicketListQuery): Promise<SupportTicketPage> {
  assertCan(ctx, 'support.read');
  const rows = await repo.listAgencyTickets(ctx.tx, ctx.tenant.agencyId, {
    ...(q.status ? { status: q.status } : {}),
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.id, atUs: r.atUs }), toSummary);
}

/** One ticket with the latest page of its conversation, or the page before `before`. */
export async function getTicket(ctx: Ctx, input: { id: string } & SupportTicketQuery): Promise<SupportTicketDto> {
  assertCan(ctx, 'support.read');
  return loadTicketDto(ctx, input.id, decodeCursor(input.before));
}

/** A member's reply: the ticket waits for staff again (a resolved one reopens). */
export async function postMessage(ctx: Ctx, input: PostSupportMessageBody & { id: string }): Promise<SupportTicketDto> {
  assertCan(ctx, 'support.write');
  const userId = memberUserId(ctx);
  const agencyId = ctx.tenant.agencyId;
  const ticket = await repo.getTicket(ctx.tx, input.id, { agencyId, forUpdate: true });
  if (!ticket) throw new AppError('NOT_FOUND');
  const now = clock.now();
  const messageId = newId();
  await repo.insertMessage(ctx.tx, {
    id: messageId,
    agencyId,
    ticketId: ticket.id,
    authorKind: 'AGENCY',
    authorUserId: userId,
    authorName: await memberName(ctx, userId),
    body: input.body,
    now,
  });
  await repo.updateTicket(ctx.tx, ticket.id, { status: 'OPEN', lastMessageAt: now, resolvedAt: null }, now);
  await emit(ctx.tx, supportEvents.messagePosted({ ticketId: ticket.id, messageId, author: 'AGENCY', isNew: false }), {
    agencyId,
  });
  return loadTicketDto(ctx, ticket.id);
}

/** The member marks the ticket solved (a later reply reopens it). */
export async function resolveTicket(ctx: Ctx, input: { id: string }): Promise<SupportTicketDto> {
  assertCan(ctx, 'support.write');
  const ticket = await repo.getTicket(ctx.tx, input.id, { agencyId: ctx.tenant.agencyId, forUpdate: true });
  if (!ticket) throw new AppError('NOT_FOUND');
  if (ticket.status !== 'RESOLVED') {
    const now = clock.now();
    await repo.updateTicket(ctx.tx, ticket.id, { status: 'RESOLVED', resolvedAt: now }, now);
  }
  return loadTicketDto(ctx, ticket.id);
}

/**
 * Attaches one file to a ticket (at most 5 × 10 MB). Checks run in a first transaction, the file goes to the private
 * bucket outside any transaction, and a second transaction records it under the ticket's row lock (re-checking the
 * cap). If recording fails, the stored object is removed again. The type comes from the magic bytes, never the header.
 */
export async function uploadAttachment(
  run: CtxRunner,
  input: UploadSupportAttachmentQuery & { id: string; body: Uint8Array },
): Promise<SupportAttachmentDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: SUPPORT_ATTACHMENT_MAX_BYTES });
  }
  const type = detectFileType(input.body);
  if (!type || !ALLOWED_TYPES.includes(type.contentType)) {
    throw new AppError('DOCUMENT_TYPE_NOT_ALLOWED', { allowed: [...ALLOWED_TYPES] });
  }

  const agencyId = await run(async (ctx) => {
    assertCan(ctx, 'support.write');
    const ticket = await repo.getTicket(ctx.tx, input.id, { agencyId: ctx.tenant.agencyId });
    if (!ticket) throw new AppError('NOT_FOUND');
    if ((await repo.countAttachments(ctx.tx, ticket.agencyId, ticket.id)) >= SUPPORT_ATTACHMENT_MAX_COUNT) {
      throw new AppError('DOCUMENT_LIMIT_REACHED', { max: SUPPORT_ATTACHMENT_MAX_COUNT });
    }
    return ticket.agencyId;
  });

  const sha256 = createHash('sha256').update(input.body).digest('hex');
  const id = newId();
  // Unguessable (UUIDv7 random bits), per agency, never derived from the file name.
  const storageKey = storageKeyOf(agencyId, id);
  await storage().put('private', storageKey, input.body, { contentType: type.contentType });

  try {
    const { dto, duplicate } = await run(async (ctx) => {
      // Same agency as the check: the caller's token names one agency.
      if (ctx.tenant.agencyId !== agencyId) throw new AppError('FORBIDDEN');
      assertCan(ctx, 'support.write');
      // One upload at a time per ticket, so parallel uploads cannot slip past the cap.
      const ticket = await repo.getTicket(ctx.tx, input.id, { agencyId, forUpdate: true });
      if (!ticket) throw new AppError('NOT_FOUND');
      // A retried upload (same content) answers with the attachment it already made.
      const existing = await repo.findAttachmentBySha(ctx.tx, agencyId, ticket.id, sha256);
      if (existing) return { dto: toAttachmentDto(existing), duplicate: true };
      if ((await repo.countAttachments(ctx.tx, agencyId, ticket.id)) >= SUPPORT_ATTACHMENT_MAX_COUNT) {
        throw new AppError('DOCUMENT_LIMIT_REACHED', { max: SUPPORT_ATTACHMENT_MAX_COUNT });
      }
      const row = await repo.insertAttachment(ctx.tx, {
        id,
        agencyId,
        ticketId: ticket.id,
        fileName: withExtension(input.fileName, type.extension),
        contentType: type.contentType,
        sizeBytes: input.body.byteLength,
        sha256,
        storageKey,
        uploadedBy: memberUserId(ctx),
        now: clock.now(),
      });
      return { dto: toAttachmentDto(row), duplicate: false };
    });
    if (duplicate) {
      await storage()
        .delete('private', storageKey)
        .catch(() => {});
    }
    return dto;
  } catch (err) {
    await storage()
      .delete('private', storageKey)
      .catch(() => {});
    throw err;
  }
}

/** A 5-minute link to one attachment (local signing, no network call). Only keys under the agency's own prefix. */
async function signAttachment(tx: Tx, agencyId: string, ticketId: string, attachmentId: string): Promise<SignedUrlDto> {
  const file = await repo.getAttachment(tx, agencyId, ticketId, attachmentId);
  if (!file?.storageKey.startsWith(`support/${agencyId}/`)) throw new AppError('NOT_FOUND');
  const url = await storage().signedGetUrl('private', file.storageKey, {
    expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    downloadName: file.fileName,
  });
  return { url, expiresAt: new Date(clock.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1_000).toISOString() };
}

export async function getAttachmentUrl(ctx: Ctx, input: { id: string; attachmentId: string }): Promise<SignedUrlDto> {
  assertCan(ctx, 'support.read');
  return signAttachment(ctx.tx, ctx.tenant.agencyId, input.id, input.attachmentId);
}

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────

/** The queue for one status, the longest waiting first (keyset), with each agency's name (one batched lookup). */
export async function listQueue(ctx: StaffCtx, q: StaffSupportQueueQuery): Promise<StaffSupportQueuePage> {
  assertStaffCan(ctx, 'staff.support.read');
  const rows = await repo.listQueue(ctx.tx, { status: q.status, limit: q.limit, cursor: decodeCursor(q.cursor) });
  const names = await agencies.agencyNames(
    ctx,
    rows.slice(0, q.limit).map((r) => r.agencyId),
  );
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.lastMessageAt, id: r.id, atUs: r.atUs }),
    (r) => ({
      ...toSummary(r),
      agency: { id: r.agencyId, name: names.get(r.agencyId) ?? '' },
      assigneeUserId: r.assigneeUserId,
    }),
  );
}

/**
 * Staff's view: a page of the conversation with the internal notes of the same span (after the page's oldest message
 * when older pages exist, before the page's cursor), one timeline, oldest first.
 */
async function loadStaffTicketDto(ctx: StaffCtx, id: string, before?: KeysetCursor): Promise<StaffSupportTicketDto> {
  const ticket = await repo.getTicket(ctx.tx, id);
  if (!ticket) throw new AppError('NOT_FOUND');
  const { messages, olderCursor, oldest } = await messagePage(ctx.tx, ticket.agencyId, id, before);
  const notes = await repo.listNotes(ctx.tx, id, {
    limit: SUPPORT_THREAD_LIMIT,
    ...(oldest ? { from: oldest.createdAt } : {}),
    ...(before ? { before } : {}),
  });
  const attachments = await repo.listAttachments(ctx.tx, ticket.agencyId, id);
  const names = await agencies.agencyNames(ctx, [ticket.agencyId]);
  const timeline: (StaffSupportMessageDto & { at: Date })[] = [
    ...messages.map((m) => ({
      id: m.id,
      author: m.authorKind,
      authorUserId: m.authorUserId,
      authorName: m.authorName,
      internal: false,
      body: m.body,
      createdAt: '',
      at: m.createdAt,
    })),
    ...notes.map((n) => ({
      id: n.id,
      author: 'STAFF' as const,
      authorUserId: n.authorUserId,
      authorName: n.authorName,
      internal: true,
      body: n.body,
      createdAt: '',
      at: n.createdAt,
    })),
  ];
  timeline.sort((x, y) => x.at.getTime() - y.at.getTime() || (x.id < y.id ? -1 : 1));
  return {
    ...toSummary(ticket),
    agency: { id: ticket.agencyId, name: names.get(ticket.agencyId) ?? '' },
    assigneeUserId: ticket.assigneeUserId,
    createdBy: ticket.createdBy,
    messages: timeline.map(({ at, ...m }) => ({ ...m, createdAt: at.toISOString() })),
    olderMessagesCursor: olderCursor,
    attachments: attachments.map(toAttachmentDto),
  };
}

export async function getStaffTicket(
  ctx: StaffCtx,
  input: { id: string } & SupportTicketQuery,
): Promise<StaffSupportTicketDto> {
  assertStaffCan(ctx, 'staff.support.read');
  return loadStaffTicketDto(ctx, input.id, decodeCursor(input.before));
}

/**
 * A staff reply (the ticket then waits for the agency, and the member who opened it is e-mailed) or an internal note
 * (`internal`: staff-only table, no status change, no event, never visible to the agency). Audited either way.
 */
export async function postStaffMessage(
  ctx: StaffCtx,
  input: StaffPostSupportMessageBody & { id: string },
): Promise<StaffSupportTicketDto> {
  assertStaffCan(ctx, 'staff.support.write');
  const ticket = await repo.getTicket(ctx.tx, input.id, { forUpdate: true });
  if (!ticket) throw new AppError('NOT_FOUND');
  const staffName = (await identity.userNames(ctx, [ctx.actor.userId])).get(ctx.actor.userId) ?? '';
  const now = clock.now();
  const target = { type: 'supportTicket' as const, id: ticket.id };
  if (input.internal) {
    const noteId = newId();
    await repo.insertNote(ctx.tx, {
      id: noteId,
      ticketId: ticket.id,
      authorUserId: ctx.actor.userId,
      authorName: staffName,
      body: input.body,
      now,
    });
    await compliance.auditStaff(ctx, ticket.agencyId, 'staff.support.noted', target, { noteId });
    return loadStaffTicketDto(ctx, ticket.id);
  }
  const messageId = newId();
  await repo.insertMessage(ctx.tx, {
    id: messageId,
    agencyId: ticket.agencyId,
    ticketId: ticket.id,
    authorKind: 'STAFF',
    authorUserId: ctx.actor.userId,
    authorName: staffName,
    body: input.body,
    now,
  });
  await repo.updateTicket(
    ctx.tx,
    ticket.id,
    { lastMessageAt: now, ...(ticket.status === 'OPEN' ? { status: 'PENDING' as const } : {}) },
    now,
  );
  await emit(ctx.tx, supportEvents.messagePosted({ ticketId: ticket.id, messageId, author: 'STAFF', isNew: false }), {
    agencyId: ticket.agencyId,
  });
  await compliance.auditStaff(ctx, ticket.agencyId, 'staff.support.replied', target, { messageId });
  return loadStaffTicketDto(ctx, ticket.id);
}

/** Triage: status (RESOLVED stamps `resolvedAt`), priority, and taking or releasing the ticket. Audited. */
export async function updateStaffTicket(
  ctx: StaffCtx,
  input: StaffUpdateSupportTicketBody & { id: string },
): Promise<StaffSupportTicketDto> {
  assertStaffCan(ctx, 'staff.support.write');
  const ticket = await repo.getTicket(ctx.tx, input.id, { forUpdate: true });
  if (!ticket) throw new AppError('NOT_FOUND');
  const now = clock.now();
  const status = input.status && input.status !== ticket.status ? input.status : undefined;
  const priority = input.priority && input.priority !== ticket.priority ? input.priority : undefined;
  await repo.updateTicket(
    ctx.tx,
    ticket.id,
    {
      ...(status ? { status, resolvedAt: status === 'RESOLVED' ? now : null } : {}),
      ...(priority ? { priority } : {}),
      ...(input.assignee ? { assigneeUserId: input.assignee === 'ME' ? ctx.actor.userId : null } : {}),
    },
    now,
  );
  await compliance.auditStaff(
    ctx,
    ticket.agencyId,
    'staff.support.triaged',
    { type: 'supportTicket', id: ticket.id },
    {
      ...(status ? { from: ticket.status, status } : {}),
      ...(priority ? { priority } : {}),
      ...(input.assignee ? { assignee: input.assignee } : {}),
    },
  );
  return loadStaffTicketDto(ctx, ticket.id);
}

export async function getStaffAttachmentUrl(
  ctx: StaffCtx,
  input: { id: string; attachmentId: string },
): Promise<SignedUrlDto> {
  assertStaffCan(ctx, 'staff.support.read');
  const ticket = await repo.getTicket(ctx.tx, input.id);
  if (!ticket) throw new AppError('NOT_FOUND');
  return signAttachment(ctx.tx, ticket.agencyId, ticket.id, input.attachmentId);
}
