import {
  WebsiteLeadAccepted,
  WebsiteLeadBody,
  WebsiteLeadHeaders,
  WebsiteViewingRequestBody,
} from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { AppError } from '@inmolink/platform/errors';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Website forms post small bodies: a 4,000-character message and the visitor's details fit in 16 KB. */
export const LEAD_BODY_LIMIT = 16_384;

const WRITE = { write: true } as const;

/** 201 for a new lead, 200 for a repeated submission (`replayed`); never stored by any cache. */
function sendAccepted(reply: FastifyReply, result: { accepted: WebsiteLeadAccepted; created: boolean }) {
  return reply
    .code(result.created ? 201 : 200)
    .header('Cache-Control', 'no-store')
    .send(WebsiteLeadAccepted.parse(result.accepted));
}

/** Who posted: the key's kind, the page origin and client IP (Turnstile), the idempotency key. Never logged. */
function factsOf(req: FastifyRequest, idempotencyKey: string): websiteApi.LeadRequestFacts {
  if (!req.apiKey) throw new AppError('NOT_AUTHENTICATED');
  return {
    keyKind: req.apiKey.kind,
    keyTier: req.apiKey.rateTier,
    origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    ip: req.ip,
    idempotencyKey,
  };
}

async function siteOf(req: FastifyRequest): Promise<websiteApi.ApiSite> {
  if (!req.apiKey) throw new AppError('NOT_AUTHENTICATED');
  return websiteApi.siteForKey(req.apiKey, req.id);
}

/**
 * Website lead intake (S7-05, PLAN §9.1): `POST /v2/leads` and `POST /v2/viewing-requests` for the key's site. Thin:
 * the key (scope, quotas, form-spam limits) in `requireApiKey`, then one core call; the lead belongs to the site's
 * agency, and the acknowledgement e-mail follows from the worker.
 */
export async function websiteLeadRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v2/leads',
    {
      bodyLimit: LEAD_BODY_LIMIT,
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.createLead',
        summary:
          "A visitor's enquiry from the site's form (about a listing by the reference the site shows, or general). Needs Turnstile (publishable keys) and an Idempotency-Key",
        headers: WebsiteLeadHeaders,
        body: WebsiteLeadBody,
        response: { 200: WebsiteLeadAccepted, 201: WebsiteLeadAccepted },
      },
      onRequest: [app.requireApiKey('leads:write', WRITE)],
    },
    async (req, reply) =>
      sendAccepted(
        reply,
        await websiteApi.submitLead(
          await siteOf(req),
          { kind: 'ENQUIRY', body: req.body },
          factsOf(req, req.headers['idempotency-key']),
        ),
      ),
  );

  app.post(
    '/v2/viewing-requests',
    {
      bodyLimit: LEAD_BODY_LIMIT,
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.createViewingRequest',
        summary:
          'A viewing request for a listing or unit (the reference the site shows) with up to three preferred slots. Needs Turnstile (publishable keys) and an Idempotency-Key',
        headers: WebsiteLeadHeaders,
        body: WebsiteViewingRequestBody,
        response: { 200: WebsiteLeadAccepted, 201: WebsiteLeadAccepted },
      },
      onRequest: [app.requireApiKey('viewing-requests:write', WRITE)],
    },
    async (req, reply) =>
      sendAccepted(
        reply,
        await websiteApi.submitLead(
          await siteOf(req),
          { kind: 'VIEWING_REQUEST', body: req.body },
          factsOf(req, req.headers['idempotency-key']),
        ),
      ),
  );
}
