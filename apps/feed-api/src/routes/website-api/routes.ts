import {
  WebsiteChangesPage,
  WebsiteChangesQuery,
  WebsiteDetail,
  WebsiteDevelopmentDetail,
  WebsiteDevelopmentPage,
  WebsiteDevelopmentParams,
  WebsiteDevelopmentsQuery,
  WebsiteLangQuery,
  WebsiteListingPage,
  WebsiteListingParams,
  WebsiteListingsQuery,
  WebsiteSitemapPage,
  WebsiteSitemapQuery,
  WebsiteUnitPage,
  WebsiteUnitsQuery,
} from '@inmolink/contracts';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { AppError } from '@inmolink/platform/errors';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyRequest } from 'fastify';
import { sendSiteJson } from '../../plugins/site-response';

/**
 * Lifetimes per endpoint once S7-06 caches site-scoped answers at the edge (ADR 0012 #5: 60–300 s; changes shorter,
 * the sitemap longer). Until then responses are private and revalidated with their ETag (`SITE_CACHE_POLICY`).
 */
export const WEBSITE_API_TTL = {
  listings: 60,
  detail: 300,
  changes: 30,
  sitemap: 600,
  // S7-F6: unit tables are live (status, price), so as short as search
  developments: 60,
  development: 300,
  units: 60,
} as const;

/** The key's site (`requireApiKey` ran first); keys without a site are refused there. */
function siteOf(req: FastifyRequest): Promise<websiteApi.ApiSite> {
  if (!req.apiKey) throw new AppError('NOT_AUTHENTICATED');
  return websiteApi.siteForKey(req.apiKey, req.id);
}

/**
 * Website API v2 reads (S7-03, PLAN §9.1): the calling key's site only, white-labelled by the core serializer. Thin:
 * the site from the key, one core call, the cached JSON with its ETag.
 */
export async function websiteApiRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v2/listings',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.listListings',
        summary: "Search the site's listings and new-build units: filters, facets, map box, sort, cursor pages",
        querystring: WebsiteListingsQuery,
        response: { 200: WebsiteListingPage },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteListingPage,
        await websiteApi.searchListings(await siteOf(req), req.query),
        WEBSITE_API_TTL.listings,
      ),
  );

  app.get(
    '/v2/listings/:ref',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getListing',
        summary: 'A listing or unit by the reference the site shows (own reference, or `<prefix>-<code>`)',
        params: WebsiteListingParams,
        querystring: WebsiteLangQuery,
        response: { 200: WebsiteDetail },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteDetail,
        await websiteApi.listingDetail(await siteOf(req), req.params.ref, req.query.lang),
        WEBSITE_API_TTL.detail,
      ),
  );

  app.get(
    '/v2/changes',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.listChanges',
        summary: "The site's delta feed: every change exactly once, in commit order (`since`, then `cursor`)",
        querystring: WebsiteChangesQuery,
        response: { 200: WebsiteChangesPage },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteChangesPage,
        await websiteApi.changes(await siteOf(req), req.query),
        WEBSITE_API_TTL.changes,
      ),
  );

  app.get(
    '/v2/sitemap',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getSitemap',
        summary: "The site's listing pages (reference, slug in `lang`, last change), one page per `cursor`",
        querystring: WebsiteSitemapQuery,
        response: { 200: WebsiteSitemapPage },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteSitemapPage,
        await websiteApi.sitemap(await siteOf(req), req.query),
        WEBSITE_API_TTL.sitemap,
      ),
  );

  app.get(
    '/v2/developments',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.listDevelopments',
        summary: "The site's new-build developments (price range, unit counts), newest first, one page per `cursor`",
        querystring: WebsiteDevelopmentsQuery,
        response: { 200: WebsiteDevelopmentPage },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteDevelopmentPage,
        await websiteApi.developments(await siteOf(req), req.query),
        WEBSITE_API_TTL.developments,
      ),
  );

  app.get(
    '/v2/developments/:ref',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getDevelopment',
        summary: 'A development by the reference the site shows (`<prefix>-<code>`)',
        params: WebsiteDevelopmentParams,
        querystring: WebsiteLangQuery,
        response: { 200: WebsiteDevelopmentDetail },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteDevelopmentDetail,
        await websiteApi.developmentDetail(await siteOf(req), req.params.ref, req.query.lang),
        WEBSITE_API_TTL.development,
      ),
  );

  app.get(
    '/v2/developments/:ref/units',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.listDevelopmentUnits',
        summary: "A development's live unit table (available and reserved units), one page per `cursor`",
        params: WebsiteDevelopmentParams,
        querystring: WebsiteUnitsQuery,
        response: { 200: WebsiteUnitPage },
      },
      onRequest: [app.requireApiKey('listings:read')],
    },
    async (req, reply) =>
      sendSiteJson(
        req,
        reply,
        WebsiteUnitPage,
        await websiteApi.developmentUnits(await siteOf(req), req.params.ref, req.query),
        WEBSITE_API_TTL.units,
      ),
  );
}
