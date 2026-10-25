import {
  BookmarkFolderList,
  type CreateSelectionBody,
  SelectionCreatedDto,
  SelectionDto,
  SelectionInteractionPage,
  SelectionPage,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Selection calls of the dashboard (S13-F13), as the signed-in member: transport only, the API decides. */

export function fetchSelections(session: SessionRef, cursor?: string): Promise<ApiResult<SelectionPage>> {
  const q = new URLSearchParams({ limit: '25' });
  if (cursor) q.set('cursor', cursor);
  return apiRequest(session, `/v1/selections?${q}`, SelectionPage);
}

export function fetchSelection(session: SessionRef, id: string): Promise<ApiResult<SelectionDto>> {
  return apiRequest(session, `/v1/selections/${encodeURIComponent(id)}`, SelectionDto);
}

export function fetchSelectionInteractions(
  session: SessionRef,
  id: string,
): Promise<ApiResult<SelectionInteractionPage>> {
  return apiRequest(
    session,
    `/v1/selections/${encodeURIComponent(id)}/interactions?limit=25`,
    SelectionInteractionPage,
  );
}

export function fetchBookmarkFolders(session: SessionRef): Promise<ApiResult<BookmarkFolderList>> {
  return apiRequest(session, '/v1/bookmark-folders', BookmarkFolderList);
}

export function createSelection(
  session: SessionRef,
  body: CreateSelectionBody,
): Promise<ApiResult<SelectionCreatedDto>> {
  return apiRequest(session, '/v1/selections', SelectionCreatedDto, { method: 'POST', body });
}

/** Stops the link now (`expiresInDays: null`, optimistic on `version`). */
export function revokeSelection(session: SessionRef, id: string, version: number): Promise<ApiResult<SelectionDto>> {
  return apiRequest(session, `/v1/selections/${encodeURIComponent(id)}`, SelectionDto, {
    method: 'PATCH',
    body: { version, expiresInDays: null },
  });
}

export function rotateSelectionLink(
  session: SessionRef,
  id: string,
  version: number,
): Promise<ApiResult<SelectionCreatedDto>> {
  return apiRequest(session, `/v1/selections/${encodeURIComponent(id)}/link`, SelectionCreatedDto, {
    method: 'POST',
    body: { version },
  });
}
