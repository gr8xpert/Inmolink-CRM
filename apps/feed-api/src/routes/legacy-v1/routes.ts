import {
  LEGACY_KEY_PARAM,
  LegacyError,
  LegacyLangQuery,
  LegacyPropertiesQuery,
  LegacyPropertyList,
  LegacyPropertyParams,
  LegacyPropertyResponse,
  LegacyTypesResponse,
} from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { AppError } from '@inmolink/platform/errors';
import { etagFor } from '@inmolink/platform/http';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { KEYED_ROUTE_LIMITS } from '../../plugins/api-key';
import { sendConditional, sendSiteJson } from '../../plugins/site-response';

/**
 * Every v1 route: the legacy key parameter (migrated legacy keys only). List pages past the first count as paging
 * (S7-04 rules) and filtered first pages towards filter-slicing (S7-F7), like `/v2/listings`.
 */
const LEGACY = { keyParam: LEGACY_KEY_PARAM } as const;
const LEGACY_LIST = { ...LEGACY, paged: true, pageParam: 'page', slicing: 'legacy-properties' } as const;
const LEGACY_DETAIL = { ...LEGACY, sync: true } as const;
/**
 * v1 answers are never stored by a shared cache (the URL carries the key): browsers and legacy plugins revalidate with
 * the ETag every time (S8-02 review: `no-cache`, not a max-age).
 */
const LEGACY_CACHE_CONTROL = 'private, no-cache';

/** Legacy messages by v2 error code; anything else keeps the HTTP reason phrase. */
const LEGACY_MESSAGES: Record<string, string> = {
  LISTING_NOT_FOUND: 'Property not found',
  NOT_AUTHENTICATED: 'Invalid API key',
  API_KEY_INVALID: 'Invalid API key',
  API_KEY_ORIGIN_DENIED: 'Invalid API key',
  API_KEY_SCOPE_DENIED: 'Invalid API key',
  API_KEY_SITE_REQUIRED: 'Invalid API key',
  VALIDATION_FAILED: 'Invalid parameter',
  RATE_LIMITED: 'Too many requests',
  QUOTA_EXCEEDED: 'Too many requests',
};

/**
 * Errors in the legacy shape (S8-02): `{ status: 'error', message }` — legacy sites test `status` — never the v2
 * envelope. The platform error handler still decides the status and logs; this rewrites the body it sent. A request
 * schema failure is a 400 (legacy APIs answered bad parameters so; v2 says 422).
 */
function legacyErrors(app: FastifyZod): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
    let code = '';
    let message = 'Error';
    try {
      const body = JSON.parse(payload) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? '';
      message = body.error?.message ?? message;
    } catch {
      return payload;
    }
    if (reply.statusCode === 422) reply.code(400);
    reply.type('application/json; charset=utf-8');
    return JSON.stringify(LegacyError.parse({ status: 'error', message: LEGACY_MESSAGES[code] ?? message }));
  });
}

function siteOf(req: FastifyRequest): Promise<websiteApi.ApiSite> {
  if (!req.apiKey) throw new AppError('NOT_AUTHENTICATED');
  return websiteApi.siteForKey(req.apiKey, req.id);
}

/** Platform reference data (the same for every key): private with a strong ETag, 304 on a match. */
function sendShared(req: FastifyRequest, reply: FastifyReply, body: LegacyTypesResponse) {
  const json = JSON.stringify(LegacyTypesResponse.parse(body));
  const etag = etagFor(json);
  if (
    sendConditional(req, reply, {
      etag,
      cacheControl: LEGACY_CACHE_CONTROL,
      vary: 'Accept-Encoding, X-Api-Key, Authorization',
    })
  ) {
    return reply;
  }
  return reply.type('application/json; charset=utf-8').send(json);
}

/**
 * Legacy website API shim `/v1` (S8-02, PLAN §9.3, §3 #43): frozen routes whose answers must match the recorded legacy
 * golden files byte for byte (after normalization) — change them only with a golden update approved in STATUS. The
 * legacy hostname's `/api/*` reaches them as `/v1/*` (edge rewrite at cutover). Thin: the site from the key, one core
 * call, the legacy body with a strong ETag (never edge-cached: legacy URLs carry the key, not `_k`).
 */
export async function legacyV1Routes(app: FastifyZod): Promise<void> {
  legacyErrors(app);

  app.get(
    '/v1/properties',
    {
      schema: {
        tags: ['website-v1'],
        operationId: 'websiteV1.listProperties',
        summary: "Legacy: one page of the site's properties (legacy ids and filters, numbered pages)",
        querystring: LegacyPropertiesQuery,
        response: { 200: LegacyPropertyList },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', LEGACY_LIST)],
    },
    async (req, reply) => {
      const suspicious = req.websitePaging?.suspicious === true;
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        LegacyPropertyList,
        await websiteApi.legacyProperties(site, req.query, { suspicious }),
        { noStore: suspicious, site, privateCacheControl: LEGACY_CACHE_CONTROL },
      );
    },
  );

  app.get(
    '/v1/properties/:id',
    {
      schema: {
        tags: ['website-v1'],
        operationId: 'websiteV1.getProperty',
        summary: 'Legacy: a property by its legacy id, or by the reference the site shows',
        params: LegacyPropertyParams,
        querystring: LegacyLangQuery,
        response: { 200: LegacyPropertyResponse },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', LEGACY_DETAIL)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        LegacyPropertyResponse,
        await websiteApi.legacyProperty(site, req.params.id, req.query.lang),
        { site, privateCacheControl: LEGACY_CACHE_CONTROL },
      );
    },
  );

  app.get(
    '/v1/types',
    {
      schema: {
        tags: ['website-v1'],
        operationId: 'websiteV1.listTypes',
        summary: 'Legacy: property types in `lang`, by legacy id',
        querystring: LegacyLangQuery,
        response: { 200: LegacyTypesResponse },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('taxonomy:read', LEGACY)],
    },
    async (req, reply) => sendShared(req, reply, await websiteApi.legacyTypes(req.query.lang)),
  );
}
