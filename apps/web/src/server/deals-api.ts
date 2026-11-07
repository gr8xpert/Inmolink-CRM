import {
  type AdvanceDealBody,
  ChatThreadDetailDto,
  type CreateTaskBody,
  DealDisputeDto,
  DealDisputeList,
  type DealDisputeStatus,
  DealDocumentDto,
  type DealDocumentKind,
  DealDocumentList,
  DealDocumentUrlDto,
  DealDto,
  DealPage,
  type DealPrice,
  type DealStage,
  fileNameHeader,
  type MediateDealBody,
  StaffDealDisputeDto,
  StaffDealDisputeList,
  StaffDealDisputePage,
  StaffDealDto,
  TaskDto,
  TaskPage,
} from '@inmolink/contracts';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * The deal room (R2-04, PLAN §3 #10): the agency's deals, one deal's moves, documents, tasks, chat thread and disputes;
 * staff mediation and the dispute queue. Transport only: the API decides who may do what.
 */

const deal = (id: string) => `/v1/mls/deals/${encodeURIComponent(id)}`;

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export function fetchDeals(
  session: SessionRef,
  o: { stage?: DealStage | undefined; cursor?: string | undefined },
): Promise<ApiResult<DealPage>> {
  return apiRequest(session, `/v1/mls/deals?${qs({ limit: 25, ...o })}`, DealPage);
}

export function fetchDeal(session: SessionRef, id: string): Promise<ApiResult<DealDto>> {
  return apiRequest(session, deal(id), DealDto);
}

export function openDeal(
  session: SessionRef,
  body: { viewingRequestId: string; price: DealPrice },
): Promise<ApiResult<DealDto>> {
  return apiRequest(session, '/v1/mls/deals', DealDto, { method: 'POST', body });
}

export function advanceDeal(session: SessionRef, id: string, body: AdvanceDealBody): Promise<ApiResult<DealDto>> {
  return apiRequest(session, `${deal(id)}/advance`, DealDto, { method: 'POST', body });
}

export function setDealPrice(session: SessionRef, id: string, price: DealPrice): Promise<ApiResult<DealDto>> {
  return apiRequest(session, `${deal(id)}/price`, DealDto, { method: 'POST', body: { price } });
}

export function confirmDeal(session: SessionRef, id: string, price: DealPrice): Promise<ApiResult<DealDto>> {
  return apiRequest(session, `${deal(id)}/confirm`, DealDto, { method: 'POST', body: { price } });
}

export function withdrawDealConfirmation(session: SessionRef, id: string): Promise<ApiResult<DealDto>> {
  return apiRequest(session, `${deal(id)}/withdraw`, DealDto, { method: 'POST' });
}

export function fallThroughDeal(session: SessionRef, id: string, reason: string): Promise<ApiResult<DealDto>> {
  return apiRequest(session, `${deal(id)}/fall-through`, DealDto, { method: 'POST', body: { reason } });
}

// ---- documents --------------------------------------------------------------------------------------------------------

export function fetchDealDocuments(session: SessionRef, id: string): Promise<ApiResult<DealDocumentList>> {
  return apiRequest(session, `${deal(id)}/documents`, DealDocumentList);
}

export function openDealDocument(
  session: SessionRef,
  id: string,
  documentId: string,
): Promise<ApiResult<DealDocumentUrlDto>> {
  return apiRequest(session, `${deal(id)}/documents/${encodeURIComponent(documentId)}/url`, DealDocumentUrlDto);
}

export function removeDealDocument(session: SessionRef, id: string, documentId: string): Promise<ApiResult<null>> {
  return apiRequest(session, `${deal(id)}/documents/${encodeURIComponent(documentId)}`, z.null(), {
    method: 'DELETE',
  });
}

export function uploadDealDocument(
  session: SessionRef,
  id: string,
  file: { kind: DealDocumentKind; fileName: string; bytes: Uint8Array },
): Promise<ApiResult<DealDocumentDto>> {
  return apiRequest(session, `${deal(id)}/documents?${qs({ kind: file.kind })}`, DealDocumentDto, {
    method: 'POST',
    raw: { bytes: file.bytes, contentType: 'application/pdf' },
    headers: fileNameHeader(file.fileName),
    timeoutMs: 60_000,
  });
}

// ---- tasks, chat, disputes --------------------------------------------------------------------------------------------

/** The agency's open tasks about the deal (any assignee), soonest first. */
export function fetchDealTasks(session: SessionRef, id: string): Promise<ApiResult<TaskPage>> {
  return apiRequest(
    session,
    `/v1/crm/tasks?${qs({ limit: 50, assignee: 'any', status: 'OPEN', dealId: id })}`,
    TaskPage,
  );
}

export function createDealTask(
  session: SessionRef,
  id: string,
  body: Pick<CreateTaskBody, 'title' | 'dueAt' | 'remind'>,
  idempotencyKey: string,
): Promise<ApiResult<TaskDto>> {
  return apiRequest(session, `${deal(id)}/tasks`, TaskDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

/** Opens (or joins) the deal's chat thread with the other party; its id is the deal's. */
export function openDealThread(session: SessionRef, dealId: string): Promise<ApiResult<ChatThreadDetailDto>> {
  return apiRequest(session, '/v1/chat/deal-threads', ChatThreadDetailDto, { method: 'POST', body: { dealId } });
}

export function fetchDealDisputes(session: SessionRef, id: string): Promise<ApiResult<DealDisputeList>> {
  return apiRequest(session, `${deal(id)}/disputes`, DealDisputeList);
}

export function openDealDispute(session: SessionRef, id: string, reason: string): Promise<ApiResult<DealDisputeDto>> {
  return apiRequest(session, `${deal(id)}/disputes`, DealDisputeDto, { method: 'POST', body: { reason } });
}

// ---- staff ------------------------------------------------------------------------------------------------------------

export function fetchStaffDealDisputes(
  session: SessionRef,
  o: { status: DealDisputeStatus; cursor?: string | undefined },
): Promise<ApiResult<StaffDealDisputePage>> {
  return apiRequest(session, `/v1/staff/deal-disputes?${qs({ limit: 50, ...o })}`, StaffDealDisputePage);
}

export function fetchStaffDeal(session: SessionRef, id: string): Promise<ApiResult<StaffDealDto>> {
  return apiRequest(session, `/v1/staff/deals/${encodeURIComponent(id)}`, StaffDealDto);
}

export function fetchStaffDisputesOfDeal(session: SessionRef, id: string): Promise<ApiResult<StaffDealDisputeList>> {
  return apiRequest(session, `/v1/staff/deals/${encodeURIComponent(id)}/disputes`, StaffDealDisputeList);
}

export function mediateDeal(session: SessionRef, id: string, body: MediateDealBody): Promise<ApiResult<StaffDealDto>> {
  return apiRequest(session, `/v1/staff/deals/${encodeURIComponent(id)}/mediate`, StaffDealDto, {
    method: 'POST',
    body,
  });
}

export function resolveDealDispute(
  session: SessionRef,
  id: string,
  note: string,
): Promise<ApiResult<StaffDealDisputeDto>> {
  return apiRequest(session, `/v1/staff/deal-disputes/${encodeURIComponent(id)}/resolve`, StaffDealDisputeDto, {
    method: 'POST',
    body: { note },
  });
}
