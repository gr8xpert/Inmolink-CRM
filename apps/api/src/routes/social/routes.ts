import {
  CompleteSocialConnectBody,
  CreateSocialPostBody,
  ListSocialPostsQuery,
  RequestSocialCaptionsBody,
  SocialAccountList,
  SocialAccountParams,
  SocialPostDto,
  SocialPostPage,
  SocialPostParams,
  SocialVersionBody,
  StartSocialConnectDto,
  UpdateSocialPostBody,
} from '@inmolink/contracts';
import * as social from '@inmolink/core/modules/social';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'social.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'social.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'social.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'social.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
];
// Connecting talks to Meta during the request: a few a minute per member, and per agency.
const CONNECT_LIMITS: readonly RateLimitRule[] = [
  ...WRITE_LIMITS,
  { name: 'social.connect.user', scope: 'user', limit: 10, windowSeconds: 600 },
  { name: 'social.connect.tenant', scope: 'tenant', limit: 30, windowSeconds: 3_600 },
];

const NO_STORE = 'no-store';

/** Social posting (S12-07): connected Facebook Pages and Instagram accounts, posts from listings and their history. */
export async function socialRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/social/accounts',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.listAccounts',
        summary: "The agency's connected Facebook Pages and Instagram Business accounts",
        response: { 200: SocialAccountList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return app.withCtx(req, (ctx) => social.listSocialAccounts(ctx));
    },
  );

  app.post(
    '/v1/social/connect',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.startConnect',
        summary: "Start connecting accounts: Meta's login dialog URL (admins)",
        response: { 200: StartSocialConnectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: CONNECT_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return app.withCtx(req, (ctx) => social.startSocialConnect(ctx));
    },
  );

  app.post(
    '/v1/social/connect/callback',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.completeConnect',
        summary: "Finish connecting: Meta's code becomes the Pages and Instagram accounts the member manages (admins)",
        body: CompleteSocialConnectBody,
        response: { 200: SocialAccountList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: CONNECT_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return social.completeSocialConnect(app.ctxRunner(req), req.body);
    },
  );

  app.delete(
    '/v1/social/accounts/:accountId',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.disconnectAccount',
        summary: 'Disconnect an account; its posts go with it (admins)',
        params: SocialAccountParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => social.disconnectSocialAccount(ctx, req.params.accountId));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/social/posts',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.listPosts',
        summary: 'Posts, newest first: status, schedule and the last error of each (cursor pagination)',
        querystring: ListSocialPostsQuery,
        response: { 200: SocialPostPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return app.withCtx(req, (ctx) => social.listSocialPosts(ctx, req.query));
    },
  );

  app.post(
    '/v1/social/posts',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.createPost',
        summary: 'Compose a post from a listing: a draft, or scheduled; AI captions on request',
        body: CreateSocialPostBody,
        response: { 200: SocialPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => social.createSocialPost(ctx, req.body)),
  );

  app.get(
    '/v1/social/posts/:postId',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.getPost',
        summary: 'One post with its captions, status and last error',
        params: SocialPostParams,
        response: { 200: SocialPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return app.withCtx(req, (ctx) => social.getSocialPost(ctx, req.params.postId));
    },
  );

  app.patch(
    '/v1/social/posts/:postId',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.updatePost',
        summary: 'Change the images, caption, language or schedule of a draft or scheduled post',
        params: SocialPostParams,
        body: UpdateSocialPostBody,
        response: { 200: SocialPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => social.updateSocialPost(ctx, req.params.postId, req.body)),
  );

  app.post(
    '/v1/social/posts/:postId/captions',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.requestCaptions',
        summary: 'Ask for AI captions in these languages (drafted by a worker; the post shows PENDING)',
        params: SocialPostParams,
        body: RequestSocialCaptionsBody,
        response: { 200: SocialPostDto },
      },
      onRequest: [app.requireSession],
      // The agency's daily caption cap is the service's (`CAPTION_REQUESTS`): it covers new posts' captions too.
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => social.requestSocialCaptions(ctx, req.params.postId, req.body)),
  );

  app.post(
    '/v1/social/posts/:postId/cancel',
    {
      schema: {
        tags: ['social'],
        operationId: 'social.cancelPost',
        summary: 'Cancel a draft or scheduled post',
        params: SocialPostParams,
        body: SocialVersionBody,
        response: { 200: SocialPostDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => social.cancelSocialPost(ctx, req.params.postId, req.body)),
  );
}
