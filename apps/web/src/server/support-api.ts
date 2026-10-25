import {
  type CreateSupportTicketBody,
  SignedUrlDto,
  type StaffPostSupportMessageBody,
  StaffSupportQueuePage,
  StaffSupportTicketDto,
  type StaffUpdateSupportTicketBody,
  SUPPORT_ATTACHMENT_TYPES,
  SupportAttachmentDto,
  SupportTicketDto,
  SupportTicketPage,
  type SupportTicketStatus,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Support tickets (S13-05): the agency side (`/v1/support/tickets`) and the staff queue (`/v1/staff/support/...`).
 * Transport only — the API authorizes; staff answers carry internal notes, agency answers never do.
 */

const ticketPath = (id: string) => `/v1/support/tickets/${encodeURIComponent(id)}`;
const staffTicketPath = (id: string) => `/v1/staff/support/tickets/${encodeURIComponent(id)}`;

export function fetchSupportTickets(
  session: SessionRef,
  q: { cursor?: string } = {},
): Promise<ApiResult<SupportTicketPage>> {
  const qs = new URLSearchParams({ limit: '25', ...(q.cursor ? { cursor: q.cursor } : {}) });
  return apiRequest(session, `/v1/support/tickets?${qs}`, SupportTicketPage);
}

export function createSupportTicket(
  session: SessionRef,
  body: CreateSupportTicketBody,
): Promise<ApiResult<SupportTicketDto>> {
  return apiRequest(session, '/v1/support/tickets', SupportTicketDto, { method: 'POST', body });
}

const beforeQuery = (before?: string) => (before ? `?${new URLSearchParams({ before })}` : '');

export function fetchSupportTicket(
  session: SessionRef,
  id: string,
  before?: string,
): Promise<ApiResult<SupportTicketDto>> {
  return apiRequest(session, `${ticketPath(id)}${beforeQuery(before)}`, SupportTicketDto);
}

export function postSupportMessage(
  session: SessionRef,
  id: string,
  body: { body: string },
): Promise<ApiResult<SupportTicketDto>> {
  return apiRequest(session, `${ticketPath(id)}/messages`, SupportTicketDto, { method: 'POST', body });
}

export function resolveSupportTicket(session: SessionRef, id: string): Promise<ApiResult<SupportTicketDto>> {
  return apiRequest(session, `${ticketPath(id)}/resolve`, SupportTicketDto, { method: 'POST' });
}

export function uploadSupportAttachment(
  session: SessionRef,
  id: string,
  fileName: string,
  file: { bytes: Uint8Array; contentType: string },
): Promise<ApiResult<SupportAttachmentDto>> {
  // Only types the API's body parser accepts; anything else is sent as octet-stream and sniffed.
  const contentType = (SUPPORT_ATTACHMENT_TYPES as readonly string[]).includes(file.contentType)
    ? file.contentType
    : 'application/octet-stream';
  return apiRequest(
    session,
    `${ticketPath(id)}/attachments?${new URLSearchParams({ fileName })}`,
    SupportAttachmentDto,
    { method: 'POST', raw: { bytes: file.bytes, contentType }, timeoutMs: 30_000 },
  );
}

export function fetchSupportAttachmentUrl(
  session: SessionRef,
  id: string,
  attachmentId: string,
): Promise<ApiResult<SignedUrlDto>> {
  return apiRequest(session, `${ticketPath(id)}/attachments/${encodeURIComponent(attachmentId)}/url`, SignedUrlDto);
}

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────

export function fetchStaffSupportQueue(
  session: SessionRef,
  q: { status: SupportTicketStatus; cursor?: string },
): Promise<ApiResult<StaffSupportQueuePage>> {
  const qs = new URLSearchParams({ status: q.status, limit: '50', ...(q.cursor ? { cursor: q.cursor } : {}) });
  return apiRequest(session, `/v1/staff/support/tickets?${qs}`, StaffSupportQueuePage);
}

export function fetchStaffSupportTicket(
  session: SessionRef,
  id: string,
  before?: string,
): Promise<ApiResult<StaffSupportTicketDto>> {
  return apiRequest(session, `${staffTicketPath(id)}${beforeQuery(before)}`, StaffSupportTicketDto);
}

export function postStaffSupportMessage(
  session: SessionRef,
  id: string,
  body: StaffPostSupportMessageBody,
): Promise<ApiResult<StaffSupportTicketDto>> {
  return apiRequest(session, `${staffTicketPath(id)}/messages`, StaffSupportTicketDto, { method: 'POST', body });
}

export function updateStaffSupportTicket(
  session: SessionRef,
  id: string,
  body: StaffUpdateSupportTicketBody,
): Promise<ApiResult<StaffSupportTicketDto>> {
  return apiRequest(session, staffTicketPath(id), StaffSupportTicketDto, { method: 'PATCH', body });
}

export function fetchStaffSupportAttachmentUrl(
  session: SessionRef,
  id: string,
  attachmentId: string,
): Promise<ApiResult<SignedUrlDto>> {
  return apiRequest(
    session,
    `${staffTicketPath(id)}/attachments/${encodeURIComponent(attachmentId)}/url`,
    SignedUrlDto,
  );
}
