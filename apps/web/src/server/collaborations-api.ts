import {
  type CreateRegistrationBody,
  type CreateViewingRequestBody,
  DevelopmentDto,
  GiveToGetGate,
  ListingContentDto,
  ListingDto,
  ReceivedRegistrationPage,
  RegistrationDto,
  RegistrationPage,
  type RegistrationTarget,
  type RegistrationTargetKind,
  type RescheduleViewingBody,
  type ViewingOutcomeBody,
  ViewingRequestDto,
  ViewingRequestPage,
  type ViewingStatus,
  ViewingTermsDocumentDto,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * "My collaborations" calls of the dashboard (S11-06), as the signed-in member: the agency's client registrations and the
 * ones received, its viewing requests as introducer and as owner. The API decides what the member sees (never the client
 * on the owner's side); these are transport only.
 */

export interface CollaborationQuery {
  limit: number;
  cursor?: string | undefined;
  kind?: RegistrationTargetKind | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

const common = (o: CollaborationQuery) => ({ limit: o.limit, cursor: o.cursor, kind: o.kind, from: o.from, to: o.to });

export function fetchOwnRegistrations(
  session: SessionRef,
  o: CollaborationQuery & { state?: 'ACTIVE' | 'EXPIRED' | undefined },
): Promise<ApiResult<RegistrationPage>> {
  return apiRequest(session, `/v1/mls/registrations?${qs({ ...common(o), state: o.state })}`, RegistrationPage);
}

export function fetchReceivedRegistrations(
  session: SessionRef,
  o: CollaborationQuery & { state?: 'ACTIVE' | 'EXPIRED' | undefined },
): Promise<ApiResult<ReceivedRegistrationPage>> {
  return apiRequest(
    session,
    `/v1/mls/received-registrations?${qs({ ...common(o), state: o.state })}`,
    ReceivedRegistrationPage,
  );
}

export function fetchOwnViewings(
  session: SessionRef,
  o: CollaborationQuery & { status?: ViewingStatus | undefined },
): Promise<ApiResult<ViewingRequestPage>> {
  return apiRequest(session, `/v1/mls/viewing-requests?${qs({ ...common(o), status: o.status })}`, ViewingRequestPage);
}

export function fetchReceivedViewings(
  session: SessionRef,
  o: CollaborationQuery & { status?: ViewingStatus | undefined },
): Promise<ApiResult<ViewingRequestPage>> {
  return apiRequest(
    session,
    `/v1/mls/received-viewing-requests?${qs({ ...common(o), status: o.status })}`,
    ViewingRequestPage,
  );
}

// ---- S17-F56: registering a client and answering viewings. Transport only: the API decides. -------------------------

/** 201: a new registration; 200: the agency's own, still valid. `status` on the result tells them apart. */
export function registerClient(session: SessionRef, body: CreateRegistrationBody): Promise<ApiResult<RegistrationDto>> {
  return apiRequest(session, '/v1/mls/registrations', RegistrationDto, { method: 'POST', body });
}

export function requestViewing(
  session: SessionRef,
  body: CreateViewingRequestBody,
  idempotencyKey: string,
): Promise<ApiResult<ViewingRequestDto>> {
  return apiRequest(session, '/v1/mls/viewing-requests', ViewingRequestDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

const viewingPath = (id: string, action: string) => `/v1/mls/viewing-requests/${encodeURIComponent(id)}/${action}`;

export function acceptViewing(session: SessionRef, id: string): Promise<ApiResult<ViewingRequestDto>> {
  return apiRequest(session, viewingPath(id, 'accept'), ViewingRequestDto, { method: 'POST' });
}

export function declineViewing(session: SessionRef, id: string): Promise<ApiResult<ViewingRequestDto>> {
  return apiRequest(session, viewingPath(id, 'decline'), ViewingRequestDto, { method: 'POST' });
}

export function cancelViewing(session: SessionRef, id: string): Promise<ApiResult<ViewingRequestDto>> {
  return apiRequest(session, viewingPath(id, 'cancel'), ViewingRequestDto, { method: 'POST' });
}

export function rescheduleViewing(
  session: SessionRef,
  id: string,
  body: RescheduleViewingBody,
): Promise<ApiResult<ViewingRequestDto>> {
  return apiRequest(session, viewingPath(id, 'reschedule'), ViewingRequestDto, { method: 'POST', body });
}

export function recordViewingOutcome(
  session: SessionRef,
  id: string,
  body: ViewingOutcomeBody,
): Promise<ApiResult<ViewingRequestDto>> {
  return apiRequest(session, viewingPath(id, 'outcome'), ViewingRequestDto, { method: 'POST', body });
}

export function fetchViewingTerms(session: SessionRef, id: string): Promise<ApiResult<ViewingTermsDocumentDto>> {
  return apiRequest(session, viewingPath(id, 'terms'), ViewingTermsDocumentDto);
}

/** The agency's give-to-get gate: while LOCKED it starts no new network action. */
export function fetchNetworkGate(session: SessionRef): Promise<ApiResult<GiveToGetGate>> {
  return apiRequest(session, '/v1/network/gate', GiveToGetGate);
}

export type RegisterTargetData =
  | { kind: 'LISTING'; listing: ListingDto; content: ListingContentDto | null }
  | { kind: 'DEVELOPMENT'; development: DevelopmentDto };

/** The listing or development the member is about to register a client for, as the API shows it to the agency. */
export async function fetchRegisterTarget(
  session: SessionRef,
  target: RegistrationTarget,
): Promise<ApiResult<RegisterTargetData>> {
  const path = encodeURIComponent(target.id);
  if (target.kind === 'DEVELOPMENT') {
    const development = await apiRequest(session, `/v1/developments/${path}`, DevelopmentDto);
    if (development === 'revoked' || !development.ok) return development;
    return { ok: true, data: { kind: 'DEVELOPMENT', development: development.data } };
  }
  const [listing, content] = await Promise.all([
    apiRequest(session, `/v1/listings/${path}`, ListingDto),
    apiRequest(session, `/v1/listings/${path}/content`, ListingContentDto),
  ]);
  if (listing === 'revoked' || !listing.ok) return listing;
  return {
    ok: true,
    data: {
      kind: 'LISTING',
      listing: listing.data,
      content: content !== 'revoked' && content.ok ? content.data : null,
    },
  };
}
