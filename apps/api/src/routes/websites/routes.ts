import { CreateSiteBody, PageQuery, SiteDto, SitePage, SiteParams, UpdateSiteBody } from '@inmolink/contracts';
import * as websites from '@inmolink/core/modules/websites';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'websites.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'websites.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
const WRITE_LIMITS: readonly RateLimitRule[] = [
  { name: 'websites.write.ip', scope: 'ip', limit: 120, windowSeconds: 60 },
  { name: 'websites.write.user', scope: 'user', limit: 30, windowSeconds: 60 },
  { name: 'websites.write.tenant', scope: 'tenant', limit: 200, windowSeconds: 3_600 },
];

/**
 * Website sites (S7-01): members list and read the agency's sites; admins create and change them (inventory
 * policy, reference prefix, locales, contact overrides). A change reaches the site's website API answers within 60 s.
 */
export async function websitesRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v1/sites',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.listSites',
        summary: 'The agency’s websites, oldest first',
        querystring: PageQuery,
        response: { 200: SitePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => websites.listSites(ctx, req.query)),
  );

  app.post(
    '/v1/sites',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.createSite',
        summary: 'Add a website (agency admins)',
        body: CreateSiteBody,
        response: { 201: SiteDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => reply.code(201).send(await app.withCtx(req, (ctx) => websites.createSite(ctx, req.body))),
  );

  app.get(
    '/v1/sites/:siteId',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.getSite',
        summary: 'One of the agency’s websites',
        params: SiteParams,
        response: { 200: SiteDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => websites.getSite(ctx, req.params)),
  );

  app.patch(
    '/v1/sites/:siteId',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.updateSite',
        summary: 'Change a website; its API answers follow within 60 s (agency admins)',
        params: SiteParams,
        body: UpdateSiteBody,
        response: { 200: SiteDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => websites.updateSite(ctx, req.params, req.body)),
  );
}
