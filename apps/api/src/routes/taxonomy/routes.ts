import { TaxonomyDto } from '@inmolink/contracts';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { cacheControl, weakCompareEtag } from '@inmolink/platform/http';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'taxonomy.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'taxonomy.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];

/** Localized taxonomy for the dashboard (S2-03): location tree, location groups, property types, features. */
export async function taxonomyRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/taxonomy',
    {
      schema: {
        tags: ['taxonomy'],
        operationId: 'taxonomy.getTaxonomy',
        summary: "Locations (tree), location groups, property types and features in the caller's locale",
        response: { 200: TaxonomyDto, 304: z.null().describe('Not modified (If-None-Match)') },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      const doc = await app.withCtx(req, (ctx) => taxonomy.getTaxonomyDocument(ctx));
      // The same for every member: the browser keeps it 5 minutes, then revalidates with the ETag.
      reply.header('cache-control', cacheControl.private(300)).header('etag', doc.etag);
      if (weakCompareEtag(req.headers['if-none-match'], doc.etag)) return reply.code(304).send(null);
      // Serialized once per tree (S3-F2), so it skips the response serializer.
      return (reply as FastifyReply).type('application/json; charset=utf-8').send(doc.json);
    },
  );
}
