import { z } from 'zod';
import { Cursor, pageOf } from './common';
import { DocumentFileName } from './verification';

/**
 * Support tickets (S13-05, PLAN §7 M21): an agency member opens a ticket (category, priority, attachments) and talks
 * to staff on it; staff triage it in the console and keep internal notes the agency never sees. Agency DTOs carry no
 * internal note and no staff member's name.
 */

/** Upload cap per attachment, and attachments per ticket (R2 private bucket). */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_COUNT = 5;
/** Types accepted, detected from magic bytes (the client's header only routes the body). */
export const SUPPORT_ATTACHMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
/**
 * Messages per page of a ticket view: the latest page first (oldest of them first on the page); older pages through
 * `olderMessagesCursor` → `?before=`.
 */
export const SUPPORT_THREAD_LIMIT = 100;

export const SupportTicketStatus = z.enum(['OPEN', 'PENDING', 'RESOLVED']);
export type SupportTicketStatus = z.infer<typeof SupportTicketStatus>;
export const SupportTicketPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export type SupportTicketPriority = z.infer<typeof SupportTicketPriority>;
export const SupportTicketCategory = z.enum([
  'ACCOUNT',
  'BILLING',
  'LISTINGS',
  'IMPORTS',
  'WEBSITE',
  'INTEGRATIONS',
  'BUG',
  'OTHER',
]);
export type SupportTicketCategory = z.infer<typeof SupportTicketCategory>;

/** One line: no control characters or < >. */
export const SupportSubject = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[^\p{Cc}<>]*$/u, 'no control characters or < >');

/** Message text: line breaks kept (normalized to LF); other control characters refused. Rendered as text only. */
export const SupportBody = z
  .string()
  .transform((v) => v.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(10_000)
      .regex(/^(?:[^\p{Cc}]|\n|\t)*$/u, 'no control characters (except line breaks and tabs)'),
  );

export const SupportTicketParams = z.object({ id: z.uuid() }).strict();
/** `GET …/tickets/:id?before=` — the page of messages before a ticket view's `olderMessagesCursor`. */
export const SupportTicketQuery = z.object({ before: Cursor.optional() }).strict();
export type SupportTicketQuery = z.infer<typeof SupportTicketQuery>;
export const SupportAttachmentParams = z.object({ id: z.uuid(), attachmentId: z.uuid() }).strict();

/** `POST /v1/support/tickets`. */
export const CreateSupportTicketBody = z
  .object({
    subject: SupportSubject,
    category: SupportTicketCategory,
    priority: SupportTicketPriority.default('NORMAL'),
    body: SupportBody,
  })
  .strict();
export type CreateSupportTicketBody = z.infer<typeof CreateSupportTicketBody>;

/** `POST /v1/support/tickets/:id/messages` — a member's reply (reopens a resolved ticket). */
export const PostSupportMessageBody = z.object({ body: SupportBody }).strict();
export type PostSupportMessageBody = z.infer<typeof PostSupportMessageBody>;

/** `POST /v1/support/tickets/:id/attachments?fileName=` — the raw file is the body. */
export const UploadSupportAttachmentQuery = z.object({ fileName: DocumentFileName }).strict();
export type UploadSupportAttachmentQuery = z.infer<typeof UploadSupportAttachmentQuery>;

export const SupportTicketListQuery = z
  .object({
    status: SupportTicketStatus.optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type SupportTicketListQuery = z.infer<typeof SupportTicketListQuery>;

export const SupportTicketSummaryDto = z.object({
  id: z.uuid(),
  subject: z.string(),
  category: SupportTicketCategory,
  priority: SupportTicketPriority,
  status: SupportTicketStatus,
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type SupportTicketSummaryDto = z.infer<typeof SupportTicketSummaryDto>;
export const SupportTicketPage = pageOf(SupportTicketSummaryDto);
export type SupportTicketPage = z.infer<typeof SupportTicketPage>;

export const SupportAttachmentDto = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type SupportAttachmentDto = z.infer<typeof SupportAttachmentDto>;

/** A message as the agency sees it: staff replies are signed by the support team, never by a staff member's name. */
export const SupportMessageDto = z.object({
  id: z.uuid(),
  author: z.enum(['AGENCY', 'STAFF']),
  /** The member's name; null on staff replies. */
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type SupportMessageDto = z.infer<typeof SupportMessageDto>;

export const SupportTicketDto = SupportTicketSummaryDto.extend({
  /** One page of the conversation (the latest, or the one before `?before=`), oldest first. */
  messages: z.array(SupportMessageDto),
  /** Pass as `?before=` for the page of older messages; null: this page starts the conversation. */
  olderMessagesCursor: Cursor.nullable(),
  attachments: z.array(SupportAttachmentDto),
});
export type SupportTicketDto = z.infer<typeof SupportTicketDto>;

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────

export const StaffSupportQueueQuery = z
  .object({
    status: SupportTicketStatus.default('OPEN'),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type StaffSupportQueueQuery = z.infer<typeof StaffSupportQueueQuery>;

const TicketAgency = z.object({ id: z.uuid(), name: z.string() });

export const StaffSupportTicketSummaryDto = SupportTicketSummaryDto.extend({
  agency: TicketAgency,
  assigneeUserId: z.uuid().nullable(),
});
export type StaffSupportTicketSummaryDto = z.infer<typeof StaffSupportTicketSummaryDto>;
export const StaffSupportQueuePage = pageOf(StaffSupportTicketSummaryDto);
export type StaffSupportQueuePage = z.infer<typeof StaffSupportQueuePage>;

export const StaffSupportMessageDto = z.object({
  id: z.uuid(),
  author: z.enum(['AGENCY', 'STAFF']),
  authorUserId: z.uuid(),
  authorName: z.string(),
  /** Staff-only note: never shown to (nor readable by) the agency. */
  internal: z.boolean(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type StaffSupportMessageDto = z.infer<typeof StaffSupportMessageDto>;

export const StaffSupportTicketDto = StaffSupportTicketSummaryDto.extend({
  createdBy: z.uuid(),
  /** One page of the conversation with the internal notes of the same span, oldest first. */
  messages: z.array(StaffSupportMessageDto),
  olderMessagesCursor: Cursor.nullable(),
  attachments: z.array(SupportAttachmentDto),
});
export type StaffSupportTicketDto = z.infer<typeof StaffSupportTicketDto>;

/** `POST /v1/staff/support/tickets/:id/messages` — a reply to the agency, or an internal note (`internal`). */
export const StaffPostSupportMessageBody = z
  .object({ body: SupportBody, internal: z.boolean().default(false) })
  .strict();
export type StaffPostSupportMessageBody = z.infer<typeof StaffPostSupportMessageBody>;

/** `PATCH /v1/staff/support/tickets/:id` — triage: status, priority, take or release the ticket. */
export const StaffUpdateSupportTicketBody = z
  .object({
    status: SupportTicketStatus.optional(),
    priority: SupportTicketPriority.optional(),
    assignee: z.enum(['ME', 'NONE']).optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.priority !== undefined || b.assignee !== undefined, 'nothing to change');
export type StaffUpdateSupportTicketBody = z.infer<typeof StaffUpdateSupportTicketBody>;
