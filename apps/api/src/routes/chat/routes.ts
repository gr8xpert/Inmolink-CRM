import {
  ChatMessagePage,
  ChatThreadDetailDto,
  ChatThreadPage,
  ChatThreadParams,
  CreateDirectThreadBody,
  ListChatMessagesQuery,
  ListChatThreadsQuery,
  MarkChatReadDto,
  OpenViewingThreadBody,
  SendChatMessageBody,
  SendChatMessageDto,
} from '@inmolink/contracts';
import * as chat from '@inmolink/core/modules/chat';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

// a chat window reads its thread list and history on focus / reconnect: generous
const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'chat.read.ip', scope: 'ip', limit: 900, windowSeconds: 60 },
  { name: 'chat.read.user', scope: 'user', limit: 300, windowSeconds: 60 },
];
// what a person types and clicks: a message a second at most, sustained
const SEND_LIMITS: readonly RateLimitRule[] = [
  { name: 'chat.send.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'chat.send.user', scope: 'user', limit: 60, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'chat.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'chat.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
// starting threads is rare
const CREATE_LIMITS: readonly RateLimitRule[] = [
  { name: 'chat.create.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'chat.create.user', scope: 'user', limit: 20, windowSeconds: 60 },
];

const tags = ['chat'];

/**
 * Chat (S11-03): the caller's threads, messages and read state. Live delivery and the typing indicator are
 * apps/realtime's (`/chat` namespace). Personal: every answer is `no-store`.
 */
export async function chatRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/chat/threads',
    {
      schema: {
        tags,
        operationId: 'chat.listThreads',
        summary: 'The caller’s threads, latest activity first (keyset, ≤ 100 per page), with their unread state',
        querystring: ListChatThreadsQuery,
        response: { 200: ChatThreadPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => chat.listThreads(ctx, req.query)),
  );

  app.post(
    '/v1/chat/threads',
    {
      schema: {
        tags,
        operationId: 'chat.createDirectThread',
        summary: 'Start a thread with colleagues of the caller’s agency (201)',
        body: CreateDirectThreadBody,
        response: { 201: ChatThreadDetailDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: CREATE_LIMITS },
    },
    async (req, reply) => reply.code(201).send(await app.withCtx(req, (ctx) => chat.createDirectThread(ctx, req.body))),
  );

  app.post(
    '/v1/chat/viewing-threads',
    {
      schema: {
        tags,
        operationId: 'chat.openViewingThread',
        summary:
          'Open (or join) the thread of a viewing request the caller’s agency is party to, with the other agency; nothing of the client is shared',
        body: OpenViewingThreadBody,
        response: { 200: ChatThreadDetailDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: CREATE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => chat.openViewingThread(ctx, req.body)),
  );

  app.get(
    '/v1/chat/threads/:id',
    {
      schema: {
        tags,
        operationId: 'chat.getThread',
        summary:
          'One of the caller’s threads, with its participants of the caller’s agency and WhatsApp / e-mail handoff links',
        params: ChatThreadParams,
        response: { 200: ChatThreadDetailDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => chat.getThread(ctx, req.params.id)),
  );

  app.get(
    '/v1/chat/threads/:id/messages',
    {
      schema: {
        tags,
        operationId: 'chat.listMessages',
        summary: 'A thread’s messages, newest first (keyset, ≤ 100 per page)',
        params: ChatThreadParams,
        querystring: ListChatMessagesQuery,
        response: { 200: ChatMessagePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => chat.listMessages(ctx, req.params.id, req.query)),
  );

  app.post(
    '/v1/chat/threads/:id/messages',
    {
      schema: {
        tags,
        operationId: 'chat.sendMessage',
        summary: 'Send a message (201); with the same clientKey, a retry answers the first message (200)',
        params: ChatThreadParams,
        body: SendChatMessageBody,
        response: { 200: SendChatMessageDto, 201: SendChatMessageDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: SEND_LIMITS },
    },
    async (req, reply) => {
      const result = await app.withCtx(req, (ctx) => chat.sendMessage(ctx, req.params.id, req.body));
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );

  app.post(
    '/v1/chat/threads/:id/read',
    {
      schema: {
        tags,
        operationId: 'chat.markThreadRead',
        summary: 'The caller read the thread up to its latest message (read receipt; its chat notifications read too)',
        params: ChatThreadParams,
        response: { 200: MarkChatReadDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => chat.markThreadRead(ctx, req.params.id)),
  );
}
