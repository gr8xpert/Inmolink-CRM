import { ApiKeyPage, ApiKeyParams, CreateApiKeyBody, IssuedApiKeyDto, PageQuery } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.apikeys.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'identity.apikeys.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'identity.apikeys.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'identity.apikeys.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
  { name: 'identity.apikeys.write.tenant', scope: 'tenant', limit: 100, windowSeconds: 3_600 },
];

/**
 * Website API keys (S1-05): agency admins list, create, rotate and revoke them. Create and rotate
 * return the whole key once, with `Cache-Control: no-store`.
 */
export async function apiKeyRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/api-keys',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.listApiKeys',
        summary: 'The agency’s website API keys, oldest first (agency admins)',
        querystring: PageQuery,
        response: { 200: ApiKeyPage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => identity.listApiKeys(ctx, req.query)),
  );

  app.post(
    '/v1/api-keys',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.createApiKey',
        summary: 'Create a website API key; the key is returned this once (admins of a verified agency)',
        body: CreateApiKeyBody,
        response: { 201: IssuedApiKeyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => reply.code(201).send(await app.withCtx(req, (ctx) => identity.createApiKey(ctx, req.body))),
  );

  app.post(
    '/v1/api-keys/:keyId/rotate',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.rotateApiKey',
        summary: 'Replace a key’s secret; the old key stops working within 60 s (agency admins)',
        params: ApiKeyParams,
        response: { 200: IssuedApiKeyDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => reply.send(await app.withCtx(req, (ctx) => identity.rotateApiKey(ctx, req.params))),
  );

  app.delete(
    '/v1/api-keys/:keyId',
    {
      schema: {
        tags: ['identity'],
        operationId: 'identity.revokeApiKey',
        summary: 'Revoke a key for good; it stops working within 60 s (agency admins)',
        params: ApiKeyParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      await app.withCtx(req, (ctx) => identity.revokeApiKey(ctx, req.params));
      return reply.code(204).send(null);
    },
  );
}
