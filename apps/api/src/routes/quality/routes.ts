import { ListingParams, ListingQualityDto } from '@inmolink/contracts';
import * as quality from '@inmolink/core/modules/quality';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'quality.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'quality.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];

/** Listing quality (S3-08): the editor's live score and fix-it hints for the agency's own listings. */
export async function qualityRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/listings/:id/quality',
    {
      schema: {
        tags: ['quality'],
        operationId: 'quality.getListingQuality',
        summary: "The agency's own listing's quality score (0–100), its parts and fix-it hints, computed now",
        params: ListingParams,
        response: { 200: ListingQualityDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, _reply) => {
      return app.withCtx(req, (ctx) => quality.getListingQuality(ctx, req.params.id));
    },
  );
}
