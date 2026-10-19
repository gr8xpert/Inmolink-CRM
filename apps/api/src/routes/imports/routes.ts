import {
  CreateFeedConnectionBody,
  FeedConnectionDto,
  FeedConnectionPage,
  FeedConnectionParams,
  FeedItemErrorPage,
  FeedRunDto,
  FeedRunPage,
  FeedRunParams,
  ListFeedConnectionsQuery,
  ListFeedItemErrorsQuery,
  ListFeedRunsQuery,
  UpdateFeedConnectionBody,
} from '@inmolink/contracts';
import * as imports from '@inmolink/core/modules/imports';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'imports.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'imports.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
  { name: 'imports.write.tenant', scope: 'tenant', limit: 300, windowSeconds: 60 },
];
/** "Run now" fetches a remote feed: few per agency and minute (the per-connection mutex refuses overlaps anyway). */
const RUN_LIMITS: readonly RateLimitRule[] = [
  { name: 'imports.run.user', scope: 'user', limit: 20, windowSeconds: 60 },
  { name: 'imports.run.tenant', scope: 'tenant', limit: 60, windowSeconds: 60 },
];

/**
 * Feed imports (S6-01): the agency's feed connections (credentials write-only), "run now", and the run history
 * with per-item errors. Nothing here is cached on the way.
 */
export async function importsRoutes(app: FastifyZod): Promise<void> {
  const tags = ['imports'];
  const read = { onRequest: [app.requireSession], config: { rateLimit: READ_LIMITS } };
  const write = { onRequest: [app.requireSession], config: { rateLimit: WRITE_LIMITS } };

  app.get(
    '/v1/imports/connections',
    {
      schema: {
        tags,
        operationId: 'imports.listFeedConnections',
        summary: "The agency's feed connections, newest first, cursor ≤ 100",
        querystring: ListFeedConnectionsQuery,
        response: { 200: FeedConnectionPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listFeedConnections(ctx, req.query));
    },
  );

  app.post(
    '/v1/imports/connections',
    {
      schema: {
        tags,
        operationId: 'imports.createFeedConnection',
        summary: 'Connect a feed (admins); credentials are stored encrypted and never returned',
        body: CreateFeedConnectionBody,
        response: { 201: FeedConnectionDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(await app.withCtx(req, (ctx) => imports.createFeedConnection(ctx, req.body)));
    },
  );

  app.get(
    '/v1/imports/connections/:id',
    {
      schema: {
        tags,
        operationId: 'imports.getFeedConnection',
        summary: 'A feed connection',
        params: FeedConnectionParams,
        response: { 200: FeedConnectionDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.getFeedConnection(ctx, req.params.id));
    },
  );

  app.patch(
    '/v1/imports/connections/:id',
    {
      schema: {
        tags,
        operationId: 'imports.updateFeedConnection',
        summary: 'Change a feed connection (admins): URL, credentials (null removes them), schedule, on/off',
        params: FeedConnectionParams,
        body: UpdateFeedConnectionBody,
        response: { 200: FeedConnectionDto },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.updateFeedConnection(ctx, req.params.id, req.body));
    },
  );

  app.delete(
    '/v1/imports/connections/:id',
    {
      schema: {
        tags,
        operationId: 'imports.deleteFeedConnection',
        summary: 'Delete a feed connection and its run history (admins)',
        params: FeedConnectionParams,
        response: { 204: z.null() },
      },
      ...write,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) => imports.deleteFeedConnection(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/imports/connections/:id/runs',
    {
      schema: {
        tags,
        operationId: 'imports.requestFeedRun',
        summary: 'Run the feed now; 409 FEED_RUN_ACTIVE while a run of it is queued or running',
        params: FeedConnectionParams,
        response: { 202: FeedRunDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: [...WRITE_LIMITS, ...RUN_LIMITS] },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.code(202).send(await app.withCtx(req, (ctx) => imports.requestFeedRun(ctx, req.params.id)));
    },
  );

  app.get(
    '/v1/imports/connections/:id/runs',
    {
      schema: {
        tags,
        operationId: 'imports.listFeedRuns',
        summary: "A connection's run history, newest first, cursor ≤ 100",
        params: FeedConnectionParams,
        querystring: ListFeedRunsQuery,
        response: { 200: FeedRunPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listFeedRuns(ctx, req.params.id, req.query));
    },
  );

  app.get(
    '/v1/imports/runs/:runId',
    {
      schema: {
        tags,
        operationId: 'imports.getFeedRun',
        summary: 'A feed run with its counts',
        params: FeedRunParams,
        response: { 200: FeedRunDto },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.getFeedRun(ctx, req.params.runId));
    },
  );

  app.get(
    '/v1/imports/runs/:runId/errors',
    {
      schema: {
        tags,
        operationId: 'imports.listFeedItemErrors',
        summary: "A run's per-item errors in feed order, cursor ≤ 100",
        params: FeedRunParams,
        querystring: ListFeedItemErrorsQuery,
        response: { 200: FeedItemErrorPage },
      },
      ...read,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => imports.listFeedItemErrors(ctx, req.params.runId, req.query));
    },
  );
}
