import { ListingParams, ListingStudioAcceptedDto, ListingStudioBody, ListingStudioBulkBody } from '@inmolink/contracts';
import * as aiFeatures from '@inmolink/core/modules/ai-features';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

/**
 * S12-02: each request queues paid model calls (one per locale; a bulk one up to 100 listings × locales), so a few
 * per minute per member; the agency's AI budget caps the spend itself.
 */
const STUDIO_LIMITS: readonly RateLimitRule[] = [
  { name: 'ai-features.studio.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'ai-features.studio.user', scope: 'user', limit: 20, windowSeconds: 60 },
  { name: 'ai-features.studio.tenant', scope: 'tenant', limit: 100, windowSeconds: 60 },
];
const STUDIO_BULK_LIMITS: readonly RateLimitRule[] = [
  { name: 'ai-features.studio-bulk.ip', scope: 'ip', limit: 30, windowSeconds: 60 },
  { name: 'ai-features.studio-bulk.user', scope: 'user', limit: 5, windowSeconds: 60 },
  { name: 'ai-features.studio-bulk.tenant', scope: 'tenant', limit: 10, windowSeconds: 60 },
];

/**
 * ai-features dashboard routes (PATTERNS §10): request and response schemas from `@inmolink/contracts`,
 * `onRequest: [app.requireSession]`, and a one-expression handler.
 */
export async function aiFeaturesRoutes(app: FastifyZod): Promise<void> {
  // ---- AI Listing Studio (S12-02): drafts are written by a worker job; the editor reloads the content ----

  app.post(
    '/v1/listings/:id/studio',
    {
      schema: {
        tags: ['ai-features'],
        operationId: 'aiFeatures.requestListingStudio',
        summary: 'Queue AI drafts (title, description, SEO meta) of one listing for the enabled locales',
        params: ListingParams,
        body: ListingStudioBody,
        response: { 202: ListingStudioAcceptedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STUDIO_LIMITS },
    },
    async (req, reply) => {
      return reply
        .code(202)
        .send(await app.withCtx(req, (ctx) => aiFeatures.requestListingStudio(ctx, req.params.id, req.body)));
    },
  );

  app.post(
    '/v1/listing-studio-batches',
    {
      schema: {
        tags: ['ai-features'],
        operationId: 'aiFeatures.requestListingStudioBulk',
        summary: 'Queue AI drafts of up to 100 listings as one batch job (locked locales are never overwritten)',
        body: ListingStudioBulkBody,
        response: { 202: ListingStudioAcceptedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STUDIO_BULK_LIMITS },
    },
    async (req, reply) => {
      return reply.code(202).send(await app.withCtx(req, (ctx) => aiFeatures.requestListingStudioBulk(ctx, req.body)));
    },
  );
}
