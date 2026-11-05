import {
  type CreateRegistrationBody,
  type CreateViewingRequestBody,
  DevelopmentDto,
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

/**
 * The registrations with a viewing open (requested or scheduled), so the list does not offer a second one (the API answers
 * `VIEWING_REQUEST_OPEN`). The newest 100 of each status; a list that fails offers the form, and the API still refuses.
 */
export async function fetchOpenViewingRegistrations(session: SessionRef): Promise<Set<string> | 'revoked'> {
  const pages = await Promise.all(
    (['REQUESTED', 'SCHEDULED'] as const).map((status) => fetchOwnViewings(session, { limit: 100, status })),
  );
  const ids = new Set<string>();
  for (const page of pages) {
    if (page === 'revoked') return 'revoked';
    if (page.ok) for (const v of page.data.items) if (v.registrationId) ids.add(v.registrationId);
  }
  return ids;
}

const ListingOwner = ListingDto.pick({ id: true, ownerUserId: true });

/**
 * Who each listing's agent is, for the member's own agency's listings (`ListingDto.ownerUserId`): who may bind the agency to a
 * viewing's terms. One call per listing, so only for non-admins, the open rows of one page (at most 25), without repeats.
 */
export async function fetchListingOwners(
  session: SessionRef,
  ids: readonly string[],
): Promise<Map<string, string | null> | 'revoked'> {
  const owners = new Map<string, string | null>();
  const results = await Promise.all(
    [...new Set(ids)].map((id) => apiRequest(session, `/v1/listings/${encodeURIComponent(id)}`, ListingOwner)),
  );
  for (const res of results) {
    if (res === 'revoked') return 'revoked';
    if (res.ok) owners.set(res.data.id, res.data.ownerUserId);
  }
  return owners;
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
