import {
  CreateSiteBody,
  PageQuery,
  SiteDto,
  SiteFeedDto,
  SiteFeedSecretDto,
  SiteFeedTokenHeaders,
  SitePage,
  SiteParams,
  UpdateSiteBody,
} from '@inmolink/contracts';
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

  // Per-site XML feeds (S7-07): members see whether the feed is on; admins turn it on (a new token, shown once),
  // rotate it (the old URL stops working) or turn it off.
  app.get(
    '/v1/sites/:siteId/feed',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.getSiteFeed',
        summary: 'The website’s XML feed: on or off, the token’s last characters, the last run',
        params: SiteParams,
        response: { 200: SiteFeedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => websites.getSiteFeed(ctx, req.params)),
  );

  app.post(
    '/v1/sites/:siteId/feed/token',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.rotateSiteFeedToken',
        summary:
          'Turn the website’s XML feed on with a new token, or rotate it; the token is shown once (agency admins). With an Idempotency-Key, a retry within 24 h answers the same token (200)',
        params: SiteParams,
        headers: SiteFeedTokenHeaders,
        response: { 200: SiteFeedSecretDto, 201: SiteFeedSecretDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    async (req, reply) => {
      const result = await app.withCtx(req, (ctx) =>
        websites.rotateSiteFeed(ctx, req.params, {
          idempotencyKey: req.headers['idempotency-key'] as string | undefined,
        }),
      );
      return reply.code(result.replayed ? 200 : 201).send(result.secret);
    },
  );

  app.delete(
    '/v1/sites/:siteId/feed',
    {
      schema: {
        tags: ['websites'],
        operationId: 'websites.revokeSiteFeed',
        summary: 'Turn the website’s XML feed off: its URL answers 404 (agency admins)',
        params: SiteParams,
        response: { 200: SiteFeedDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: WRITE_LIMITS },
    },
    (req) => app.withCtx(req, (ctx) => websites.revokeSiteFeed(ctx, req.params)),
  );
}
