import {
  ChatThreadDetailDto,
  ChatThreadParams,
  CreateContactHeaders,
  CreateNetworkPostBody,
  ListNetworkPostsQuery,
  NetworkPostDto,
  NetworkPostPage,
  NetworkPostParams,
  NetworkReplyDto,
  NetworkSubscriptionBody,
  NetworkSubscriptionDto,
  NetworkSubscriptionList,
  NetworkSubscriptionParams,
  ReplyNetworkPostBody,
} from '@inmolink/contracts';
import * as network from '@inmolink/core/modules/network';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'network.board.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'network.board.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
// a post reaches every subscriber of the network: few per member, fewer per agency than a spammer would want
const POST_LIMITS: readonly RateLimitRule[] = [
  { name: 'network.board.post.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'network.board.post.user', scope: 'user', limit: 20, windowSeconds: 3_600 },
  { name: 'network.board.post.tenant', scope: 'tenant', limit: 100, windowSeconds: 86_400 },
];
// each reply to a new post opens a thread in another agency and notifies its author: capped per agency too
const REPLY_LIMITS: readonly RateLimitRule[] = [
  { name: 'network.board.reply.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'network.board.reply.user', scope: 'user', limit: 30, windowSeconds: 60 },
  { name: 'network.board.reply.tenant', scope: 'tenant', limit: 300, windowSeconds: 86_400 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'network.board.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'network.board.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
];

const tags = ['network'];

/**
 * Network board (S11-05): posts of the network's agencies, replies (a chat thread with the poster) and the caller's
 * subscriptions. Between agencies, per caller: every answer is `no-store`.
 */
export async function networkRoutes(app: FastifyZod): Promise<void> {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/v1/network/posts',
    {
      schema: {
        tags,
        operationId: 'network.listPosts',
        summary:
          'The board: open, unexpired posts of the network and the agency’s own, newest first (keyset, ≤ 100 per page); mine=true for the agency’s own posts in every state',
        querystring: ListNetworkPostsQuery,
        response: { 200: NetworkPostPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.listPosts(ctx, req.query)),
  );

  app.get(
    '/v1/network/posts/:id',
    {
      schema: {
        tags,
        operationId: 'network.getPost',
        summary: 'One post (the agency’s own, or an open one of the network)',
        params: NetworkPostParams,
        response: { 200: NetworkPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.getPost(ctx, req.params.id)),
  );

  app.post(
    '/v1/network/posts',
    {
      schema: {
        tags,
        operationId: 'network.createPost',
        summary:
          'Post a buyer request, property offer, distressed sale or developer announcement with structured criteria to the network (verified agencies, 201). With an Idempotency-Key, a retry within 24 h answers the first post (200)',
        headers: CreateContactHeaders,
        body: CreateNetworkPostBody,
        response: { 201: NetworkPostDto, 200: NetworkPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: POST_LIMITS },
    },
    async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await app.withCtx(req, (ctx) =>
        network.createPost(ctx, req.body, idempotencyKey ? { idempotencyKey } : {}),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.post);
    },
  );

  app.post(
    '/v1/network/posts/:id/close',
    {
      schema: {
        tags,
        operationId: 'network.closePost',
        summary: 'Take the agency’s post off the board (its author or an admin); reply threads stay open',
        params: NetworkPostParams,
        response: { 200: NetworkPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.closePost(ctx, req.params.id)),
  );

  app.post(
    '/v1/network/posts/:id/replies',
    {
      schema: {
        tags,
        operationId: 'network.replyToPost',
        summary:
          'Reply to another agency’s open post: the agency’s chat thread with the poster (opened on the first reply) and the caller’s message in it; clientKey replays a retried send',
        params: NetworkPostParams,
        body: ReplyNetworkPostBody,
        response: { 200: NetworkReplyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: REPLY_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.replyToPost(ctx, req.params.id, req.body)),
  );

  app.post(
    '/v1/network/threads/:id/join',
    {
      schema: {
        tags,
        operationId: 'network.joinReplyThread',
        summary: 'Join one of the agency’s reply threads (admins; the post’s author is seated on it already)',
        params: ChatThreadParams,
        response: { 200: ChatThreadDetailDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.joinReplyThread(ctx, req.params.id)),
  );

  app.get(
    '/v1/network/subscriptions',
    {
      schema: {
        tags,
        operationId: 'network.listSubscriptions',
        summary: 'The caller’s board subscriptions (filters), oldest first',
        response: { 200: NetworkSubscriptionList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.listSubscriptions(ctx)),
  );

  app.post(
    '/v1/network/subscriptions',
    {
      schema: {
        tags,
        operationId: 'network.createSubscription',
        summary: 'Subscribe the caller to other agencies’ posts matching these filters (201; at most 20 per member)',
        body: NetworkSubscriptionBody,
        response: { 201: NetworkSubscriptionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) =>
      reply.code(201).send(await app.withCtx(req, (ctx) => network.createSubscription(ctx, req.body))),
  );

  app.put(
    '/v1/network/subscriptions/:id',
    {
      schema: {
        tags,
        operationId: 'network.updateSubscription',
        summary: 'Replace the filters of one of the caller’s subscriptions',
        params: NetworkSubscriptionParams,
        body: NetworkSubscriptionBody,
        response: { 200: NetworkSubscriptionDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => network.updateSubscription(ctx, req.params.id, req.body)),
  );

  app.delete(
    '/v1/network/subscriptions/:id',
    {
      schema: {
        tags,
        operationId: 'network.deleteSubscription',
        summary: 'Delete one of the caller’s subscriptions',
        params: NetworkSubscriptionParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => network.deleteSubscription(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );
}
