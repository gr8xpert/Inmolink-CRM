import {
  type ClientProfileDto,
  ClientProfileMatchMoveDto,
  ClientProfileMatchPage,
  ClientProfilePage,
  ClientProfileDto as ClientProfileSchema,
  type CreateClientProfileBody,
  type SavedSearchBody,
  SavedSearchDto,
  SavedSearchList,
  type UpdateClientProfileBody,
} from '@inmolink/contracts';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Saved searches (S5-06), client profiles and the review queue (R2-02d), as the signed-in member: transport only, the API decides. */

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export function fetchSavedSearches(session: SessionRef): Promise<ApiResult<SavedSearchList>> {
  return apiRequest(session, '/v1/saved-searches', SavedSearchList);
}

export function createSavedSearch(session: SessionRef, body: SavedSearchBody): Promise<ApiResult<SavedSearchDto>> {
  return apiRequest(session, '/v1/saved-searches', SavedSearchDto, { method: 'POST', body });
}

export function deleteSavedSearch(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/saved-searches/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}

/* R2-02d: a contact's client profiles (R2-02a's API). */

export function fetchClientProfiles(session: SessionRef, contactId: string): Promise<ApiResult<ClientProfilePage>> {
  // a contact has at most 10 profiles on create (a merge can add more: the first page is shown)
  return apiRequest(
    session,
    `/v1/crm/contacts/${encodeURIComponent(contactId)}/profiles?${query({ limit: 25 })}`,
    ClientProfilePage,
  );
}

export function createClientProfile(
  session: SessionRef,
  contactId: string,
  body: CreateClientProfileBody,
): Promise<ApiResult<ClientProfileDto>> {
  return apiRequest(session, `/v1/crm/contacts/${encodeURIComponent(contactId)}/profiles`, ClientProfileSchema, {
    method: 'POST',
    body,
  });
}

export function updateClientProfile(
  session: SessionRef,
  id: string,
  body: UpdateClientProfileBody,
): Promise<ApiResult<ClientProfileDto>> {
  return apiRequest(session, `/v1/client-profiles/${encodeURIComponent(id)}`, ClientProfileSchema, {
    method: 'PUT',
    body,
  });
}

export function deleteClientProfile(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/client-profiles/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}

/* R2-02d: the review queue. */

export function fetchClientProfileMatches(
  session: SessionRef,
  o: { status: 'PENDING_REVIEW' | 'DISMISSED'; contactId?: string; profileId?: string; cursor?: string },
): Promise<ApiResult<ClientProfileMatchPage>> {
  return apiRequest(session, `/v1/client-profile-matches?${query({ limit: 25, ...o })}`, ClientProfileMatchPage);
}

export function moveClientProfileMatch(
  session: SessionRef,
  id: string,
  move: 'approve' | 'dismiss' | 'restore',
): Promise<ApiResult<ClientProfileMatchMoveDto>> {
  return apiRequest(
    session,
    `/v1/client-profile-matches/${encodeURIComponent(id)}/${move}`,
    ClientProfileMatchMoveDto,
    { method: 'POST' },
  );
}
