import {
  ReceivedRegistrationPage,
  RegistrationPage,
  type RegistrationTargetKind,
  ViewingRequestPage,
  type ViewingStatus,
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
