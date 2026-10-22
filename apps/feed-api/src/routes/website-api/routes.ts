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
import { KEYED_ROUTE_LIMITS } from '../../plugins/api-key';
import { sendSiteJson } from '../../plugins/site-response';

/** Edge lifetimes per endpoint (S7-06): defined in core with the purge horizon they set. */
export const WEBSITE_API_TTL = websiteApi.WEBSITE_API_TTL;

/**
 * List endpoints: a request with a `cursor` counts against the paging rules (S7-04). `/v2/changes` too (S7-F7): paging
 * volume never flags a secret key (a plugin polls with a cursor all day long), while a browser crawling the change feed
 * meets its per-browser paging limits.
 */
const PAGED = { paged: true } as const;
/** `/v2/listings`: deep-paging rules, and filtered first pages count towards filter-slicing (S7-F7). */
const LISTINGS = { paged: true, listings: true, slicing: 'listings' } as const;
/** `/v2/developments`: filtered first pages count towards filter-slicing too (S7-F7). */
const DEVELOPMENTS = { paged: true, slicing: 'developments' } as const;
/** Details count towards the sync budget, net of what the change feed explained (S7-F7). */
const DETAIL = { sync: true } as const;
/** Sitemap pages: paging rules, and the sync budget (a sitemap + detail crawl, S7-F7). */
const SITEMAP = { paged: true, sync: true } as const;

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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', LISTINGS)],
    },
    async (req, reply) => {
      const suspicious = req.websitePaging?.suspicious === true;
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        WebsiteListingPage,
        await websiteApi.searchListings(site, req.query, { suspicious }),
        WEBSITE_API_TTL.listings,
        { noStore: suspicious, site },
      );
    },
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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', DETAIL)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        WebsiteDetail,
        await websiteApi.listingDetail(site, req.params.ref, req.query.lang),
        WEBSITE_API_TTL.detail,
        { site },
      );
    },
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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', PAGED)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      const page = await websiteApi.changes(site, req.query);
      app.creditChangeFeed(req, page.items);
      return sendSiteJson(req, reply, WebsiteChangesPage, page, WEBSITE_API_TTL.changes, { site, edge: false });
    },
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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', SITEMAP)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        WebsiteSitemapPage,
        await websiteApi.sitemap(site, req.query),
        WEBSITE_API_TTL.sitemap,
        { site },
      );
    },
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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', DEVELOPMENTS)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        WebsiteDevelopmentPage,
        await websiteApi.developments(site, req.query),
        WEBSITE_API_TTL.developments,
        { site },
      );
    },
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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', DETAIL)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        WebsiteDevelopmentDetail,
        await websiteApi.developmentDetail(site, req.params.ref, req.query.lang),
        WEBSITE_API_TTL.development,
        { site },
      );
    },
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
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('listings:read', PAGED)],
    },
    async (req, reply) => {
      const site = await siteOf(req);
      return sendSiteJson(
        req,
        reply,
        WebsiteUnitPage,
        await websiteApi.developmentUnits(site, req.params.ref, req.query),
        WEBSITE_API_TTL.units,
        { site },
      );
    },
  );
}
