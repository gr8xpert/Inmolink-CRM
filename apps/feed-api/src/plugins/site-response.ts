import * as websiteApi from '@inmolink/core/modules/website-api';
import { cacheControl, etagFor, weakCompareEtag } from '@inmolink/platform/http';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { edgePublic, publicCacheControl, ruleOf } from './edge-cache';

/**
 * Cache policy of site-scoped website API responses (S7-03 review, S7-06). The site comes from the key (a header), so
 * the same URL answers differently per site. Two independent safeguards keep a cached answer with its key:
 *
 * 1. **The URL** — an answer is public only when the request carries `_k`, the token of its key and browser origin
 *    (`edgeKeyToken`; the SDK adds it): cached URLs differ per key and origin, and without `_k` nothing is cacheable,
 *    even under a zone-wide "cache everything" rule;
 * 2. **The CDN rule** (`infra/cloudflare/cache-rules.json`): the origin's `Vary: X-Api-Key, Authorization` values are
 *    passed through into the cache key; any other varying header (`Origin` on private answers) bypasses the cache.
 *
 * - **edge cache off** (`WEBSITE_EDGE_CACHE=false`, the default, and until the rule is live): `private` — browsers and
 *   the WordPress plugin revalidate with the strong ETag (304, no body), no shared cache stores them;
 * - **edge cache on**: first pages and details requested with a valid `_k` are `public, s-maxage=<ttl>,
 *   stale-while-revalidate=<ttl>, stale-if-error=86400` (`max-age=0`: browsers still revalidate) with `Cache-Tag`s for
 *   purging; same normalized URL (path, sorted query — strict query schemas refuse unknown parameters — and `lang`).
 *
 * Per route in `EDGE_CACHE_RULES` (S8-F2). Never edge-cached: pages with a `cursor` (deep pages must pass the origin's paging rules, S7-04), `/v2/changes`,
 * answers to suspicious callers (`private, no-store`: they may carry a honeytoken), errors and 429s
 * (`edgeSafeErrors`), form posts (`no-store`).
 */
export const SITE_CACHE_POLICY = {
  private: cacheControl.private(0),
  vary: 'Accept-Encoding, X-Api-Key, Authorization, Origin',
  /** Public answers: the browser origin is part of the URL (`_k`), so `Origin` is not a varying header. */
  publicVary: 'Accept-Encoding, X-Api-Key, Authorization',
} as const;

export interface SiteJsonOptions {
  /** Never stored anywhere (S7-04: a suspicious caller's answer). Default: the caller is suspicious. */
  noStore?: boolean;
  /** The request's site: what its answer showed names its `Cache-Tag`s (S7-06). Without it: never edge-cached. */
  site?: websiteApi.ApiSite;
  /** The `Cache-Control` of a private answer (S8-02: the v1 shim's `private, no-cache`). */
  privateCacheControl?: string;
}

/**
 * A site-scoped JSON answer: validated against its contract first (the strict shapes are the white-label safety net,
 * and the body is sent pre-serialized, so Fastify's response schema would not run), serialized once, hashed for a
 * strong ETag; `If-None-Match` → 304. Public for the CDN when the route's rule allows it (`EDGE_CACHE_RULES`) and
 * the site's purge tags exist, else private.
 */
export function sendSiteJson<S extends z.ZodType>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: S,
  body: z.input<S>,
  options: SiteJsonOptions = {},
) {
  const json = JSON.stringify(schema.parse(body));
  if (options.noStore ?? req.websitePaging?.suspicious === true) {
    // S7-04: an answer to a suspected scraper (it may carry a honeytoken) is never stored or revalidated anywhere.
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Vary', SITE_CACHE_POLICY.vary)
      .type('application/json; charset=utf-8')
      .send(json);
  }
  // The route's own rule (`EDGE_CACHE_RULES`, looked up by the matched route: a handler cannot pass another's).
  const rule = ruleOf(req);
  const tags = options.site && edgePublic(req, rule) ? websiteApi.edgeTagsOf(options.site) : null;
  const etag = etagFor(json);
  reply
    .header(
      'Cache-Control',
      tags ? publicCacheControl(rule) : (options.privateCacheControl ?? SITE_CACHE_POLICY.private),
    )
    .header('ETag', etag)
    .header('Vary', tags ? SITE_CACHE_POLICY.publicVary : SITE_CACHE_POLICY.vary);
  // Cloudflare strips it before the client; the tags are keyed hashes, never ids.
  if (tags) reply.header('Cache-Tag', tags.join(','));
  if (weakCompareEtag(req.headers['if-none-match'], etag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(json);
}

/**
 * S7-06: no error is ever stored by a shared cache — a 404, a 401 or a 429 (rate limits, quotas) is the origin's
 * answer to that request at that moment. Errors are `private, no-store` with no `Cache-Tag`, whatever set them.
 */
export function edgeSafeErrors(app: FastifyZod): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode >= 400) {
      reply.header('Cache-Control', 'private, no-store');
      reply.removeHeader('Cache-Tag');
    }
    return payload;
  });
}

/** Headers a browser may send to the website API, and read back. */
const ALLOW_HEADERS = 'X-Api-Key, If-None-Match, Content-Type, Idempotency-Key';
const EXPOSE_HEADERS = 'ETag, Retry-After';

/**
 * CORS for publishable keys (S7-03 review): a browser widget's request carries `X-Api-Key`, so it is preflighted.
 * Preflights (no key yet) are answered for any origin — the request itself is refused unless its origin is on the
 * key's allowlist (`requireApiKey`). An authenticated publishable-key answer echoes that (allowlisted) origin with
 * `Vary: Origin`; responses that set their own `Access-Control-Allow-Origin` (public taxonomy: `*`) keep it.
 */
export function websiteCors(app: FastifyZod): void {
  app.options('/v2/*', { schema: { hide: true } }, async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    return reply
      .header('Access-Control-Allow-Methods', 'GET, POST')
      .header('Access-Control-Allow-Headers', ALLOW_HEADERS)
      .header('Access-Control-Max-Age', '600')
      .code(204)
      .send();
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const origin = req.headers.origin;
    if (origin && req.apiKey?.kind === 'PUBLISHABLE' && !reply.hasHeader('Access-Control-Allow-Origin')) {
      reply.header('Access-Control-Allow-Origin', origin).header('Access-Control-Expose-Headers', EXPOSE_HEADERS);
      const vary = reply.getHeader('Vary');
      // A public answer's URL carries the origin (`_k`): `Origin` stays out of its Vary (the CDN rule bypasses on it).
      const shared = /^public\b/.test(String(reply.getHeader('Cache-Control') ?? ''));
      if (!shared && (typeof vary !== 'string' || !/\borigin\b/i.test(vary))) {
        reply.header('Vary', vary ? `${vary}, Origin` : 'Origin');
      }
    }
    return payload;
  });
}
