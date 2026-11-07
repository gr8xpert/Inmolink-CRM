import { type CreateWindowCardsBody, PdfDocumentDto } from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Window-card calls of the dashboard (R2-06): transport only, the API decides who may and what is shown. */

export function createWindowCards(
  session: SessionRef,
  body: CreateWindowCardsBody,
): Promise<ApiResult<PdfDocumentDto>> {
  return apiRequest(session, '/v1/window-cards', PdfDocumentDto, { method: 'POST', body });
}

export function fetchWindowCards(session: SessionRef, documentId: string): Promise<ApiResult<PdfDocumentDto>> {
  return apiRequest(session, `/v1/window-cards/${encodeURIComponent(documentId)}`, PdfDocumentDto);
}
