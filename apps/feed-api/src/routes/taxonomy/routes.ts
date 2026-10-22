import {
  LocationParams,
  TaxonomyCatalogDto,
  TaxonomyChildrenQuery,
  TaxonomyLangQuery,
  WebsiteFeaturesDto,
  WebsiteLocationChildrenDto,
  WebsiteLocationsDto,
  WebsiteTypesDto,
} from '@inmolink/contracts';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { cacheControl, weakCompareEtag } from '@inmolink/platform/http';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { KEYED_ROUTE_LIMITS } from '../../plugins/api-key';

/** Taxonomy changes rarely; the CDN keeps it 10 min and revalidates with the ETag. */
const CDN_SECONDS = 600;

/**
 * Taxonomy query schemas strip unknown parameters instead of refusing them, so a URL with any other parameter would be
 * another CDN entry for the same answer (cache-busting load on the origin): only `lang`, `cursor` and `_k` (S7-06)
 * keep an answer public. Taxonomy is the same for every key and site, so it needs no `_k` (S7-06 Decision).
 */
const TAXONOMY_PARAMS = new Set(['lang', 'cursor', '_k']);
function normalQuery(req: FastifyRequest): boolean {
  const at = req.url.indexOf('?');
  return at < 0 || [...new URLSearchParams(req.url.slice(at + 1)).keys()].every((k) => TAXONOMY_PARAMS.has(k));
}

/** The body is already JSON (serialized once per cached copy), so it skips the response serializer. */
function send(req: FastifyRequest, reply: FastifyReply, doc: taxonomy.Serialized) {
  reply
    .header('Cache-Control', normalQuery(req) ? cacheControl.feed({ sMaxAge: CDN_SECONDS }) : cacheControl.private(0))
    .header('ETag', doc.etag)
    // S7-06: the edge cache keys by these (passthrough), so a cached copy only answers the key that fetched it.
    .header('Vary', 'Accept-Encoding, X-Api-Key, Authorization')
    // Platform reference data, the same for every site and key: shareable by any widget origin (S7-03).
    .header('Access-Control-Allow-Origin', '*');
  if (weakCompareEtag(req.headers['if-none-match'], doc.etag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(doc.json);
}

/**
 * Website API taxonomy (S2-03): platform reference data, the same for every site; no query when warm.
 * Locations come one level at a time (countries with regions, then any location's children).
 */
export async function taxonomyRoutes(app: FastifyZod): Promise<void> {
  app.get(
    '/v2/taxonomy/locations',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getTaxonomyLocations',
        summary: 'Countries with their regions, and the location groups, in `lang`',
        querystring: TaxonomyLangQuery,
        response: { 200: WebsiteLocationsDto },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('taxonomy:read')],
    },
    async (req, reply) => send(req, reply, await taxonomy.getWebsiteLocations(req.query.lang)),
  );

  app.get(
    '/v2/taxonomy/locations/:id/children',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getTaxonomyLocationChildren',
        summary: "A location's direct children (a region's cities, a city's areas) in `lang`, one page per `cursor`",
        params: LocationParams,
        querystring: TaxonomyChildrenQuery,
        response: { 200: WebsiteLocationChildrenDto },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('taxonomy:read')],
    },
    async (req, reply) =>
      send(req, reply, await taxonomy.getWebsiteLocationChildren(req.params.id, req.query.lang, req.query.cursor)),
  );

  app.get(
    '/v2/taxonomy/catalog',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getTaxonomyCatalog',
        summary: 'Property types and features (with Lucide icon names), grouped, in `lang`',
        querystring: TaxonomyLangQuery,
        response: { 200: TaxonomyCatalogDto },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('taxonomy:read')],
    },
    async (req, reply) => send(req, reply, await taxonomy.getWebsiteCatalog(req.query.lang)),
  );

  // S7-F6: the catalog's halves as PLAN §9.1 names them. Not narrowed to the site's inventory: the same answer for
  // every key keeps them CDN-cacheable; counts per type or feature come from `/v2/listings?facets=`.
  app.get(
    '/v2/taxonomy/types',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getTaxonomyTypes',
        summary: 'Property types, grouped, in `lang`',
        querystring: TaxonomyLangQuery,
        response: { 200: WebsiteTypesDto },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('taxonomy:read')],
    },
    async (req, reply) => send(req, reply, await taxonomy.getWebsiteTypes(req.query.lang)),
  );

  app.get(
    '/v2/taxonomy/features',
    {
      schema: {
        tags: ['website-v2'],
        operationId: 'websiteV2.getTaxonomyFeatures',
        summary: 'Features (with Lucide icon names), grouped, in `lang`',
        querystring: TaxonomyLangQuery,
        response: { 200: WebsiteFeaturesDto },
      },
      config: { rateLimit: KEYED_ROUTE_LIMITS },
      onRequest: [app.requireApiKey('taxonomy:read')],
    },
    async (req, reply) => send(req, reply, await taxonomy.getWebsiteFeatures(req.query.lang)),
  );
}
