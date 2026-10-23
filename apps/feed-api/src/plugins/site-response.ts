import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
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
  /** Never stored anywhere: suspicious callers' answers, errors, feed redirects to signed storage URLs. */
  noStore: `private, ${cacheControl.noStore()}`,
  vary: 'Accept-Encoding, X-Api-Key, Authorization, Origin',
  /** Public answers: the browser origin is part of the URL (`_k`), so `Origin` is not a varying header. */
  publicVary: 'Accept-Encoding, X-Api-Key, Authorization',
} as const;

export interface ConditionalOptions {
  /** The strong (or weak) validator of the answer. */
  etag: string;
  cacheControl: string;
  /** Omitted: no `Vary` header. */
  vary?: string;
}

/**
 * The one ETag / 304 step of every conditional GET (S9-F6): sets `Cache-Control`, `ETag` and `Vary`, and answers 304
 * with no body when `If-None-Match` matches (weak comparison, `*` and lists included). Returns true when the 304 was
 * sent — the handler then returns the reply; otherwise it goes on with the body. Headers a route adds itself
 * (`Cache-Tag`, `X-Robots-Tag`, ...) are set before the call so a 304 carries them too.
 */
export function sendConditional(req: FastifyRequest, reply: FastifyReply, options: ConditionalOptions): boolean {
  reply.header('Cache-Control', options.cacheControl).header('ETag', options.etag);
  if (options.vary) reply.header('Vary', options.vary);
  if (!weakCompareEtag(req.headers['if-none-match'], options.etag)) return false;
  reply.code(304).send();
  return true;
}

/** Whether the client takes gzip (`Accept-Encoding`, ignoring `gzip;q=0`). */
function acceptsGzip(req: FastifyRequest): boolean {
  const header = req.headers['accept-encoding'];
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return value.split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== 'x-gzip') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** A stored feed file as the core answers it (`websiteApi.siteFeedFile`, `exports.portalFeedFile`). */
export interface StoredFeedAnswer {
  /** Strong ETag of the stored gzip file. */
  etag: string;
  /** `Cache-Tag`s, or null before boot configured the tags (never edge-cached then). */
  tags: string[] | null;
  open(): Promise<NodeJS.ReadableStream>;
  signedUrl(): Promise<string>;
}

/**
 * The one serving step of the stored XML feeds (S10-F2: site and portal feeds): never indexed, the stored gzip file
 * streamed as it is to clients that take gzip (the CDN does) or decompressed on the fly, one ETag per stored file and
 * encoding, `If-None-Match` → 304 (no storage read). Public for the CDN when the route's rule allows it and the purge
 * tags exist (`Vary: Accept-Encoding`, `Cache-Tag`); with the edge cache off a poll is redirected to a
 * short-lived signed storage URL (S8-F1; S10-F9: plain-XML polls too), so a feed never streams through the origin on every poll.
 */
export async function sendStoredFeed(req: FastifyRequest, reply: FastifyReply, file: StoredFeedAnswer) {
  const gzip = acceptsGzip(req);
  // One ETag per stored file and encoding (the bytes differ).
  const etag = gzip ? file.etag : `${file.etag.slice(0, -1)}.identity"`;
  // Edge cache on, purge tags, and no query parameter (another CDN entry for the same file: S8-F2).
  const rule = ruleOf(req);
  const shared = edgePublic(req, rule) && file.tags !== null;
  reply
    .header('X-Robots-Tag', 'noindex, nofollow')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff');
  if (shared && file.tags) reply.header('Cache-Tag', file.tags.join(','));
  if (
    sendConditional(req, reply, {
      etag,
      cacheControl: shared ? publicCacheControl(rule) : cacheControl.private(0),
      vary: 'Accept-Encoding',
    })
  ) {
    return reply;
  }
  // Edge cache off (S10-F9): every poll that needs the body — gzip or not — goes to the signed storage URL, so feed-api
  // never streams (or gunzips) a whole feed per poll; the URL serves the stored gzip as gzip-encoded XML.
  if (!shared) {
    return reply.header('Cache-Control', SITE_CACHE_POLICY.noStore).redirect(await file.signedUrl(), 302);
  }
  const body = await file.open();
  reply.type('application/xml; charset=utf-8');
  // Streams are sent as they are (the route's response schema documents the XML; it never serializes a stream).
  if (gzip) return reply.header('Content-Encoding', 'gzip').send(body);
  // pipeline: an error on either side (a storage read cut short, corrupt gzip) destroys both, and so the reply.
  const plain = createGunzip();
  pipeline(body, plain, (err) => {
    if (err) req.log.warn({ err: err.name }, 'stored feed: stream failed');
  });
  return reply.send(plain);
}

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
      .header('Cache-Control', SITE_CACHE_POLICY.noStore)
      .header('Vary', SITE_CACHE_POLICY.vary)
      .type('application/json; charset=utf-8')
      .send(json);
  }
  // The route's own rule (`EDGE_CACHE_RULES`, looked up by the matched route: a handler cannot pass another's).
  const rule = ruleOf(req);
  const tags = options.site && edgePublic(req, rule) ? websiteApi.edgeTagsOf(options.site) : null;
  const etag = etagFor(json);
  // Cloudflare strips `Cache-Tag` before the client; the tags are keyed hashes, never ids.
  if (tags) reply.header('Cache-Tag', tags.join(','));
  if (
    sendConditional(req, reply, {
      etag,
      cacheControl: tags ? publicCacheControl(rule) : (options.privateCacheControl ?? SITE_CACHE_POLICY.private),
      vary: tags ? SITE_CACHE_POLICY.publicVary : SITE_CACHE_POLICY.vary,
    })
  ) {
    return reply;
  }
  return reply.type('application/json; charset=utf-8').send(json);
}

/**
 * S7-06: no error is ever stored by a shared cache — a 404, a 401 or a 429 (rate limits, quotas) is the origin's
 * answer to that request at that moment. Errors are `private, no-store` with no `Cache-Tag`, whatever set them.
 */
export function edgeSafeErrors(app: FastifyZod): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode >= 400) {
      reply.header('Cache-Control', SITE_CACHE_POLICY.noStore);
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
