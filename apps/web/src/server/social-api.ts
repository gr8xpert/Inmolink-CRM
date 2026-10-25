import {
  type CreateSocialPostBody,
  SocialAccountList,
  SocialPostDto,
  SocialPostPage,
  StartSocialConnectDto,
} from '@inmolink/contracts';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Social posting calls of the dashboard (S12-07), as the signed-in member: transport only, the API decides. */

export function fetchSocialAccounts(session: SessionRef): Promise<ApiResult<SocialAccountList>> {
  return apiRequest(session, '/v1/social/accounts', SocialAccountList);
}

export function fetchSocialPosts(session: SessionRef, cursor?: string): Promise<ApiResult<SocialPostPage>> {
  const q = new URLSearchParams({ limit: '25' });
  if (cursor) q.set('cursor', cursor);
  return apiRequest(session, `/v1/social/posts?${q}`, SocialPostPage);
}

export function startSocialConnect(session: SessionRef): Promise<ApiResult<StartSocialConnectDto>> {
  return apiRequest(session, '/v1/social/connect', StartSocialConnectDto, { method: 'POST' });
}

export function completeSocialConnect(
  session: SessionRef,
  body: { code: string; state: string },
): Promise<ApiResult<SocialAccountList>> {
  // Meta's code exchange happens during this call: give it Meta's time.
  return apiRequest(session, '/v1/social/connect/callback', SocialAccountList, {
    method: 'POST',
    body,
    timeoutMs: 30_000,
  });
}

export function disconnectSocialAccount(session: SessionRef, accountId: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/social/accounts/${encodeURIComponent(accountId)}`, z.null(), {
    method: 'DELETE',
  });
}

export function createSocialPost(session: SessionRef, body: CreateSocialPostBody): Promise<ApiResult<SocialPostDto>> {
  return apiRequest(session, '/v1/social/posts', SocialPostDto, { method: 'POST', body });
}

export function cancelSocialPost(
  session: SessionRef,
  postId: string,
  version: number,
): Promise<ApiResult<SocialPostDto>> {
  return apiRequest(session, `/v1/social/posts/${encodeURIComponent(postId)}/cancel`, SocialPostDto, {
    method: 'POST',
    body: { version },
  });
}
