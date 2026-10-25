import { SavedSearchBody, SavedSearchDto, SavedSearchList, SavedSearchParams } from '@inmolink/contracts';
import * as matching from '@inmolink/core/modules/matching';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'matching.saved-searches.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'matching.saved-searches.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'matching.saved-searches.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'matching.saved-searches.write.user', scope: 'user', limit: 60, windowSeconds: 60 },
];

const tags = ['matching'];

/**
 * Saved searches (S5-06, PLAN §7 M9): the caller's own searches with alerts on new listings, price drops and returns
 * to the market. Per caller: every answer is `no-store`.
 */
export async function matchingRoutes(app: FastifyZod): Promise<void> {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/v1/saved-searches',
    {
      schema: {
        tags,
        operationId: 'matching.listSavedSearches',
        summary: 'The caller’s saved searches, oldest first (at most 50)',
        response: { 200: SavedSearchList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.listSavedSearches(ctx)),
  );

  app.post(
    '/v1/saved-searches',
    {
      schema: {
        tags,
        operationId: 'matching.createSavedSearch',
        summary: 'Save a search with alerts (201; at most 50 per member)',
        body: SavedSearchBody,
        response: { 201: SavedSearchDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) =>
      reply.code(201).send(await app.withCtx(req, (ctx) => matching.createSavedSearch(ctx, req.body))),
  );

  app.put(
    '/v1/saved-searches/:id',
    {
      schema: {
        tags,
        operationId: 'matching.updateSavedSearch',
        summary: 'Replace one of the caller’s saved searches',
        params: SavedSearchParams,
        body: SavedSearchBody,
        response: { 200: SavedSearchDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => matching.updateSavedSearch(ctx, req.params.id, req.body)),
  );

  app.delete(
    '/v1/saved-searches/:id',
    {
      schema: {
        tags,
        operationId: 'matching.deleteSavedSearch',
        summary: 'Delete one of the caller’s saved searches and its alerts',
        params: SavedSearchParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => matching.deleteSavedSearch(ctx, req.params.id));
      return reply.code(204).send(null);
    },
  );
}
