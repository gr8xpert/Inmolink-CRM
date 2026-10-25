import {
  type CreateNetworkPostBody,
  type NetworkPostDto,
  type NetworkPostKind,
  NetworkPostPage,
  NetworkPostDto as NetworkPostSchema,
  NetworkReplyDto,
  type NetworkSubscriptionBody,
  NetworkSubscriptionDto,
  NetworkSubscriptionList,
} from '@inmolink/contracts';
import { z } from 'zod';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Network board calls of the dashboard (S12-F1), as the signed-in member: transport only, the API decides. */

export interface BoardQuery {
  limit: number;
  cursor?: string | undefined;
  kind?: NetworkPostKind | undefined;
  mine?: boolean | undefined;
}

export function fetchBoardPosts(session: SessionRef, o: BoardQuery): Promise<ApiResult<NetworkPostPage>> {
  const q = new URLSearchParams({ limit: String(o.limit) });
  if (o.cursor) q.set('cursor', o.cursor);
  if (o.kind) q.set('kind', o.kind);
  if (o.mine) q.set('mine', 'true');
  return apiRequest(session, `/v1/network/posts?${q}`, NetworkPostPage);
}

export function createBoardPost(
  session: SessionRef,
  body: CreateNetworkPostBody,
  idempotencyKey: string,
): Promise<ApiResult<NetworkPostDto>> {
  return apiRequest(session, '/v1/network/posts', NetworkPostSchema, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function closeBoardPost(session: SessionRef, id: string): Promise<ApiResult<NetworkPostDto>> {
  return apiRequest(session, `/v1/network/posts/${encodeURIComponent(id)}/close`, NetworkPostSchema, {
    method: 'POST',
  });
}

export function replyToBoardPost(
  session: SessionRef,
  id: string,
  body: { body: string; clientKey?: string | undefined },
): Promise<ApiResult<NetworkReplyDto>> {
  return apiRequest(session, `/v1/network/posts/${encodeURIComponent(id)}/replies`, NetworkReplyDto, {
    method: 'POST',
    body,
  });
}

export function fetchSubscriptions(session: SessionRef): Promise<ApiResult<NetworkSubscriptionList>> {
  return apiRequest(session, '/v1/network/subscriptions', NetworkSubscriptionList);
}

export function createSubscription(
  session: SessionRef,
  body: NetworkSubscriptionBody,
): Promise<ApiResult<NetworkSubscriptionDto>> {
  return apiRequest(session, '/v1/network/subscriptions', NetworkSubscriptionDto, { method: 'POST', body });
}

export function deleteSubscription(session: SessionRef, id: string): Promise<ApiResult<null>> {
  return apiRequest(session, `/v1/network/subscriptions/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE' });
}
