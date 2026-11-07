import {
  type CreateCollaborationAgreementBody,
  type CreateDealSignatureRequestBody,
  type CreateFormDocumentBody,
  type CreateSignatureRequestBody,
  DealSignersDto,
  FormDocumentDto,
  FormDocumentPage,
  type FormTemplate,
  ListingPage,
  SignatureRequestDto,
  SignatureRequestList,
  VerifySignedPdfResult,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * The forms library and its e-signatures in the dashboard (R2-05c; API R2-05a / R2-05b): forms of the agency, one
 * form's signing requests, the deal room's collaboration agreement and its signers. Transport only: the API decides
 * who may do what, and answers `FORMS_NOT_ENABLED` / `ESIGN_NOT_ENABLED` while the flags are off.
 */

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};
const form = (id: string) => `/v1/documents/forms/${encodeURIComponent(id)}`;
const request = (id: string) => `/v1/documents/signature-requests/${encodeURIComponent(id)}`;
const deal = (id: string) => `/v1/mls/deals/${encodeURIComponent(id)}`;
const key = (idempotencyKey: string) => ({ 'idempotency-key': idempotencyKey });

export interface FormsFilter {
  template?: FormTemplate | undefined;
  contactId?: string | undefined;
  listingId?: string | undefined;
  dealId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export function fetchForms(session: SessionRef, f: FormsFilter): Promise<ApiResult<FormDocumentPage>> {
  return apiRequest(session, `/v1/documents/forms?${qs({ limit: 25, ...f })}`, FormDocumentPage);
}

/** One form, with a 15-minute download link once READY (none while staff act as the member). */
export function fetchForm(session: SessionRef, id: string): Promise<ApiResult<FormDocumentDto>> {
  return apiRequest(session, form(id), FormDocumentDto);
}

export function createForm(
  session: SessionRef,
  body: CreateFormDocumentBody,
  idempotencyKey: string,
): Promise<ApiResult<FormDocumentDto>> {
  return apiRequest(session, '/v1/documents/forms', FormDocumentDto, {
    method: 'POST',
    body,
    headers: key(idempotencyKey),
  });
}

export function createCollaborationAgreement(
  session: SessionRef,
  dealId: string,
  body: CreateCollaborationAgreementBody,
  idempotencyKey: string,
): Promise<ApiResult<FormDocumentDto>> {
  return apiRequest(session, `${deal(dealId)}/collaboration-agreement`, FormDocumentDto, {
    method: 'POST',
    body,
    headers: key(idempotencyKey),
  });
}

export function fetchSignatureRequests(session: SessionRef, formId: string): Promise<ApiResult<SignatureRequestList>> {
  return apiRequest(session, `${form(formId)}/signature-requests`, SignatureRequestList);
}

/** One request, with a 15-minute link to the signed PDF once COMPLETED. */
export function fetchSignatureRequest(session: SessionRef, id: string): Promise<ApiResult<SignatureRequestDto>> {
  return apiRequest(session, request(id), SignatureRequestDto);
}

export function createSignatureRequest(
  session: SessionRef,
  formId: string,
  body: CreateSignatureRequestBody,
  idempotencyKey: string,
): Promise<ApiResult<SignatureRequestDto>> {
  return apiRequest(session, `${form(formId)}/signature-requests`, SignatureRequestDto, {
    method: 'POST',
    body,
    headers: key(idempotencyKey),
  });
}

/** Raw PDF body: whether it is the signed PDF, the original or neither (nothing stored). */
export function verifySignedPdf(
  session: SessionRef,
  requestId: string,
  bytes: Uint8Array,
): Promise<ApiResult<VerifySignedPdfResult>> {
  return apiRequest(session, `${request(requestId)}/verify`, VerifySignedPdfResult, {
    method: 'POST',
    raw: { bytes, contentType: 'application/pdf' },
    timeoutMs: 60_000,
  });
}

/** Who may sign the deal's collaboration agreement for each party (its deal members and admins). */
export function fetchDealSigners(session: SessionRef, dealId: string): Promise<ApiResult<DealSignersDto>> {
  return apiRequest(session, `${deal(dealId)}/signers`, DealSignersDto);
}

export function createDealSignatureRequest(
  session: SessionRef,
  dealId: string,
  body: CreateDealSignatureRequestBody,
  idempotencyKey: string,
): Promise<ApiResult<SignatureRequestDto>> {
  return apiRequest(session, `${deal(dealId)}/signature-requests`, SignatureRequestDto, {
    method: 'POST',
    body,
    headers: key(idempotencyKey),
  });
}

/** The agency's newest listings (the generate form's listing picker). */
export function fetchRecentListings(session: SessionRef): Promise<ApiResult<ListingPage>> {
  return apiRequest(session, '/v1/listings?limit=50', ListingPage);
}
