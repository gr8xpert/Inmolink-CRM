import { type SavedSearchBody, SavedSearchDto, SavedSearchList } from '@inmolink/contracts';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Saved searches of the dashboard (S5-06), as the signed-in member: transport only, the API decides. */

export function fetchSavedSearches(session: SessionRef): Promise<ApiResult<SavedSearchList>> {
  return apiRequest(session, '/v1/saved-searches', SavedSearchList);
}

export function createSavedSearch(session: SessionRef, body: SavedSearchBody): Promise<ApiResult<SavedSearchDto>> {
  return apiRequest(session, '/v1/saved-searches', SavedSearchDto, { method: 'POST', body });
}

export function deleteSavedSearch(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/saved-searches/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}
