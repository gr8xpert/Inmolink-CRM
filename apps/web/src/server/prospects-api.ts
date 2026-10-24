import {
  ContactPage,
  type ContactPage as ContactPageType,
  type ConvertProspectInput,
  type CreateProspectBody,
  type MoveProspectBody,
  ProspectBoardDto,
  ProspectConversionDto,
  ProspectDeletedDto,
  ProspectDto,
  ProspectPage,
  type ProspectStage,
  type UpdateProspectBody,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Acquisition board calls of the dashboard (S10-07), as the signed-in member: the board, a column's next page, the list,
 * the follow-ups by date, one prospect, and the writes (create, edit, drag, convert, delete).
 */

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export function fetchProspectBoard(session: SessionRef, limit = 20): Promise<ApiResult<ProspectBoardDto>> {
  return apiRequest(session, `/v1/crm/prospects/board?${query({ limit })}`, ProspectBoardDto);
}

export function fetchStageProspects(
  session: SessionRef,
  stage: ProspectStage,
  cursor: string,
): Promise<ApiResult<ProspectPage>> {
  return apiRequest(
    session,
    `/v1/crm/prospects/stages/${encodeURIComponent(stage)}?${query({ limit: 20, cursor })}`,
    ProspectPage,
  );
}

export function fetchProspectList(
  session: SessionRef,
  o: { stage?: ProspectStage | undefined; cursor?: string | undefined; assigned?: 'me' | undefined },
): Promise<ApiResult<ProspectPage>> {
  return apiRequest(
    session,
    `/v1/crm/prospects?${query({ limit: 25, stage: o.stage, cursor: o.cursor, assigned: o.assigned })}`,
    ProspectPage,
  );
}

export function fetchProspectFollowUps(
  session: SessionRef,
  o: { from: Date; to: Date; cursor?: string | undefined },
): Promise<ApiResult<ProspectPage>> {
  return apiRequest(
    session,
    `/v1/crm/prospects/follow-ups?${query({ limit: 100, from: o.from.toISOString(), to: o.to.toISOString(), cursor: o.cursor })}`,
    ProspectPage,
  );
}

export function fetchProspect(session: SessionRef, id: string): Promise<ApiResult<ProspectDto>> {
  return apiRequest(session, `/v1/crm/prospects/${encodeURIComponent(id)}`, ProspectDto);
}

/** The seller picker: the agency's newest seller contacts (a contact search comes with the contacts screens). */
export function fetchSellerContacts(session: SessionRef): Promise<ApiResult<ContactPageType>> {
  return apiRequest(session, `/v1/crm/contacts?${query({ limit: 100, type: 'SELLER' })}`, ContactPage);
}

export function createProspect(
  session: SessionRef,
  body: CreateProspectBody,
  idempotencyKey: string,
): Promise<ApiResult<ProspectDto>> {
  return apiRequest(session, '/v1/crm/prospects', ProspectDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function updateProspect(
  session: SessionRef,
  id: string,
  body: UpdateProspectBody,
): Promise<ApiResult<ProspectDto>> {
  return apiRequest(session, `/v1/crm/prospects/${encodeURIComponent(id)}`, ProspectDto, { method: 'PATCH', body });
}

export function moveProspect(session: SessionRef, id: string, body: MoveProspectBody): Promise<ApiResult<ProspectDto>> {
  return apiRequest(session, `/v1/crm/prospects/${encodeURIComponent(id)}/move`, ProspectDto, {
    method: 'POST',
    body,
  });
}

export function convertProspect(
  session: SessionRef,
  id: string,
  body: ConvertProspectInput,
): Promise<ApiResult<ProspectConversionDto>> {
  return apiRequest(session, `/v1/crm/prospects/${encodeURIComponent(id)}/convert`, ProspectConversionDto, {
    method: 'POST',
    body,
  });
}

export function deleteProspect(session: SessionRef, id: string): Promise<ApiResult<ProspectDeletedDto>> {
  return apiRequest(session, `/v1/crm/prospects/${encodeURIComponent(id)}`, ProspectDeletedDto, {
    method: 'DELETE',
  });
}
