import {
  ChatMessagePage,
  ChatThreadDetailDto,
  ChatThreadPage,
  MarkChatReadDto,
  SendChatMessageDto,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Chat calls of the dashboard (S12-F1), as the signed-in member: transport only. */

const page = (o: { limit: number; cursor?: string | undefined }) => {
  const q = new URLSearchParams({ limit: String(o.limit) });
  if (o.cursor) q.set('cursor', o.cursor);
  return q.toString();
};

export function fetchThreads(
  session: SessionRef,
  o: { limit: number; cursor?: string | undefined },
): Promise<ApiResult<ChatThreadPage>> {
  return apiRequest(session, `/v1/chat/threads?${page(o)}`, ChatThreadPage);
}

export function fetchThread(session: SessionRef, id: string): Promise<ApiResult<ChatThreadDetailDto>> {
  return apiRequest(session, `/v1/chat/threads/${encodeURIComponent(id)}`, ChatThreadDetailDto);
}

export function fetchMessages(
  session: SessionRef,
  id: string,
  o: { limit: number; cursor?: string | undefined },
): Promise<ApiResult<ChatMessagePage>> {
  return apiRequest(session, `/v1/chat/threads/${encodeURIComponent(id)}/messages?${page(o)}`, ChatMessagePage);
}

export function sendMessage(
  session: SessionRef,
  id: string,
  body: { body: string; clientKey?: string | undefined },
): Promise<ApiResult<SendChatMessageDto>> {
  return apiRequest(session, `/v1/chat/threads/${encodeURIComponent(id)}/messages`, SendChatMessageDto, {
    method: 'POST',
    body,
  });
}

export function markThreadRead(session: SessionRef, id: string): Promise<ApiResult<MarkChatReadDto>> {
  return apiRequest(session, `/v1/chat/threads/${encodeURIComponent(id)}/read`, MarkChatReadDto, { method: 'POST' });
}
