import * as exportsModule from '@inmolink/core/modules/exports';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { cacheControl } from '@inmolink/platform/http';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    /** `WEBSITE_EDGE_CACHE` (S7-06): first pages and details are `public` for the CDN, keyed by the API key. */
    websiteEdgeCache: boolean;
  }
}

/**
 * Who may get a CDN-cacheable (`public`) answer from a route (S8-F2):
 * - `key`: the answer differs per API key and site — only with the edge cache on (`WEBSITE_EDGE_CACHE`) and the
 *   request's `_k` token of its key and browser origin, exactly once (S7-06);
 * - `url`: the URL alone is the credential and the cache key (feed tokens) — only with the edge cache on;
 * - `always`: the same answer for every key and site (taxonomy) — public whatever the flag (S7-06 Decision);
 * - `never`: never stored by a shared cache (`/v2/changes`: every change exactly once, per caller).
 */
export type EdgeGate = 'key' | 'url' | 'always' | 'never';

export interface EdgeCacheRule {
  gate: EdgeGate;
  /** CDN lifetime of a public answer, seconds (`stale-while-revalidate` the same); `null` with gate `never`. */
  sMaxAge: number | null;
  /** How long the edge may serve a cached copy while the origin fails, seconds. */
  staleIfError: number;
  /** `false`: a request with a `cursor` (even an empty one) is never public — deep pages pass the origin's paging rules. */
  cursorPages: boolean;
  /**
   * The query parameters a public answer's URL may carry; any other makes it private (another CDN entry for the same
   * answer would be cache-busting load on the origin). `null`: the route's strict query schema refuses others already.
   */
  params: readonly string[] | null;
}

const DAY = 86_400;
/** Taxonomy changes rarely; the CDN keeps it 10 min and revalidates with the ETag. */
const TAXONOMY_TTL = 600;
/** Taxonomy schemas strip unknown parameters instead of refusing them: only these keep an answer public. */
const TAXONOMY_PARAMS = ['lang', 'cursor', '_k'] as const;

const keyed = (sMaxAge: number, cursorPages = false): EdgeCacheRule => ({
  gate: 'key',
  sMaxAge,
  staleIfError: DAY,
  cursorPages,
  params: null,
});
const taxonomy: EdgeCacheRule = {
  gate: 'always',
  sMaxAge: TAXONOMY_TTL,
  staleIfError: DAY,
  cursorPages: true,
  params: TAXONOMY_PARAMS,
};

const legacy: EdgeCacheRule = { gate: 'never', sMaxAge: null, staleIfError: 0, cursorPages: false, params: null };

/**
 * The edge-cache policy of every `/v2/*` GET route (S8-F2: one table, pinned by `edge-cache.test.ts`). Lifetimes of
 * site answers come from core (`WEBSITE_API_TTL`: they set the purge horizon). What is never public whatever the table
 * says: answers to suspicious callers (`private, no-store`, S7-04), errors and 429s (`edgeSafeErrors`), site answers
 * without their purge tags, form posts.
 */
export const EDGE_CACHE_RULES = {
  '/v2/listings': keyed(websiteApi.WEBSITE_API_TTL.listings),
  '/v2/listings/:ref': keyed(websiteApi.WEBSITE_API_TTL.detail),
  '/v2/changes': { gate: 'never', sMaxAge: null, staleIfError: 0, cursorPages: false, params: null },
  '/v2/sitemap': keyed(websiteApi.WEBSITE_API_TTL.sitemap),
  '/v2/developments': keyed(websiteApi.WEBSITE_API_TTL.developments),
  '/v2/developments/:ref': keyed(websiteApi.WEBSITE_API_TTL.development),
  '/v2/developments/:ref/units': keyed(websiteApi.WEBSITE_API_TTL.units),
  '/v2/taxonomy/locations': taxonomy,
  '/v2/taxonomy/locations/:id/children': taxonomy,
  '/v2/taxonomy/catalog': taxonomy,
  '/v2/taxonomy/types': taxonomy,
  '/v2/taxonomy/features': taxonomy,
  // The v1 shim (S8-02): legacy URLs carry the key itself (`api_key`), not the `_k` token — private, ETag revalidation.
  '/v1/properties': legacy,
  '/v1/properties/:id': legacy,
  '/v1/types': legacy,
  // S8-05: the WordPress plugin's update server — the same for every site, no key; the package is immutable.
  '/v2/plugin/update': { gate: 'always', sMaxAge: 60, staleIfError: DAY, cursorPages: false, params: [] },
  '/v2/plugin/package/:version': {
    gate: 'always',
    sMaxAge: 365 * DAY,
    staleIfError: DAY,
    cursorPages: false,
    params: [],
  },
  // A short stale-if-error: a revoked or rotated token's copy never outlives a failed purge by a day (S7-07).
  '/v2/feeds/:token/:file': {
    gate: 'url',
    sMaxAge: websiteApi.SITE_FEED_TTL,
    staleIfError: websiteApi.SITE_FEED_STALE_IF_ERROR,
    cursorPages: false,
    params: [],
  },
  // S9-03: portal feeds, like the site feeds (the token URL is the key; a revoked token's copy dies within minutes).
  '/v2/portal-feeds/:token/:file': {
    gate: 'url',
    sMaxAge: exportsModule.PORTAL_FEED_TTL,
    staleIfError: exportsModule.PORTAL_FEED_STALE_IF_ERROR,
    cursorPages: false,
    params: [],
  },
} as const satisfies Record<string, EdgeCacheRule>;

export type EdgeRoute = keyof typeof EDGE_CACHE_RULES;

/** The `Cache-Control` of a rule's public answer. */
export function publicCacheControl(rule: EdgeCacheRule): string {
  if (rule.sMaxAge === null) throw new Error('edge-cache: a never-public rule has no public Cache-Control');
  return cacheControl.feed({ sMaxAge: rule.sMaxAge, staleIfError: rule.staleIfError });
}

/**
 * The query string as the CDN keys on it, if it is in its one written form (S8-F2 review): what `URLSearchParams`
 * writes back from its own parse (the SDK and the WordPress plugin write it so), every key once, no value with
 * surrounding blanks. `null` for anything else — `%6Cang=en`, `lang=e%6E`, `lang=en+`, `lang=en&lang=en`, a bare
 * trailing `?` — each another CDN entry for the same answer.
 */
export function canonicalQuery(url: string): URLSearchParams | null {
  const at = url.indexOf('?');
  if (at < 0) return new URLSearchParams();
  const raw = url.slice(at + 1);
  const q = new URLSearchParams(raw);
  if (raw === '' || q.toString() !== raw) return null;
  const keys = [...q.keys()];
  if (new Set(keys).size !== keys.length) return null;
  for (const v of q.values()) if (v !== v.trim()) return null;
  return q;
}

/** The rule of the route serving `req` (`EDGE_CACHE_RULES`); a `/v2` GET route without one is a programming error. */
export function ruleOf(req: FastifyRequest): EdgeCacheRule {
  const url = req.routeOptions.url;
  const rule = url === undefined ? undefined : (EDGE_CACHE_RULES as Record<string, EdgeCacheRule>)[url];
  if (!rule) throw new Error(`edge-cache: no rule for route ${url ?? '(none)'}`);
  return rule;
}

/** Whether this request may get a CDN-cacheable answer under its route's rule (the route's other conditions aside). */
export function edgePublic(req: FastifyRequest, rule: EdgeCacheRule = ruleOf(req)): boolean {
  if (rule.gate === 'never' || rule.sMaxAge === null) return false;
  if (rule.gate !== 'always' && !req.server.websiteEdgeCache) return false;
  const q = canonicalQuery(req.url);
  if (q === null) return false;
  if (!rule.cursorPages && q.has('cursor')) return false;
  const allowed = rule.params;
  if (allowed !== null && ![...q.keys()].every((k) => allowed.includes(k))) return false;
  const token = q.get('_k');
  // `key`: this key's and origin's token, required. Otherwise a `_k`, if any, must still be the caller's own (a random
  // one would be another entry for the same answer).
  if (rule.gate === 'key') return req.edgeKeyToken !== null && token === req.edgeKeyToken;
  return token === null || (req.edgeKeyToken !== null && token === req.edgeKeyToken);
}
