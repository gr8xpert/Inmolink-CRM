import {
  ListingMediaList,
  ListingMediaParams,
  ListingParams,
  MediaCheckBody,
  MediaCheckResult,
  RegisterMediaBody,
} from '@inmolink/contracts';
import * as media from '@inmolink/core/modules/media';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'media.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'media.read.user', scope: 'user', limit: 240, windowSeconds: 60 },
];
/** A check or register call carries up to 100 files, so a 1,000-photo import fits in 20 calls. */
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'media.write.ip', scope: 'ip', limit: 300, windowSeconds: 60 },
  { name: 'media.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
  { name: 'media.write.tenant', scope: 'tenant', limit: 1_200, windowSeconds: 60 },
];

/**
 * Listing media (S3-03): content-addressed uploads. The browser hashes files, `check` answers which are stored
 * already (zero bytes to send) and signs PUT URLs for the rest — the file goes straight to object storage, never
 * through the API — then `register` verifies the uploads and attaches them to a listing.
 */
export async function mediaRoutes(app: FastifyZod): Promise<void> {
  app.post(
    '/v1/media/check',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.checkUploads',
        summary: 'Which files (by SHA-256) are stored already; signed upload URLs for the others (≤ 100)',
        body: MediaCheckBody,
        response: { 200: MediaCheckResult },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => media.checkUploads(ctx, req.body));
    },
  );

  app.post(
    '/v1/media/register',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.registerUploads',
        summary: "Verify uploaded files and attach them to a listing in order; answers the listing's media",
        body: RegisterMediaBody,
        response: { 200: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return media.registerUploads(app.ctxRunner(req), req.body);
    },
  );

  app.get(
    '/v1/listings/:id/media',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.listListingMedia',
        summary: "A listing's media in order (other agencies never see its documents)",
        params: ListingParams,
        response: { 200: ListingMediaList },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return app.withCtx(req, (ctx) => media.listListingMedia(ctx, req.params.id));
    },
  );

  app.delete(
    '/v1/listings/:id/media/:mediaId',
    {
      schema: {
        tags: ['media'],
        operationId: 'media.detachListingMedia',
        summary: 'Remove a file from a listing; an object nothing uses any more is deleted after 7 days',
        params: ListingMediaParams,
        response: { 204: z.null() },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await app.withCtx(req, (ctx) =>
        media.detachListingMedia(ctx, { listingId: req.params.id, mediaId: req.params.mediaId }),
      );
      return reply.code(204).send(null);
    },
  );
}
