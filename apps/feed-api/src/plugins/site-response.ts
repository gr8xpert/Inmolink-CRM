import { cacheControl, etagFor, weakCompareEtag } from '@inmolink/platform/http';
import type { FastifyZod } from '@inmolink/platform/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * Cache policy of site-scoped website API responses (S7-03 review). The site comes from the key (a header), so the
 * same URL answers differently per site — and Cloudflare ignores `Vary` (except encoding). Until S7-06 keys the CDN
 * cache by site, these responses are `private`: browsers and the WordPress plugin revalidate with the strong ETag
 * (304, no body), no shared cache stores them. S7-06 switches `SITE_CACHE_POLICY` to public + site-scoped keys.
 */
export const SITE_CACHE_POLICY = {
  cacheControl: (_ttlSeconds: number) => cacheControl.private(0),
  vary: 'Accept-Encoding, X-Api-Key, Authorization, Origin',
} as const;

/**
 * A site-scoped JSON answer: validated against its contract first (the strict shapes are the white-label safety net,
 * and the body is sent pre-serialized, so Fastify's response schema would not run), serialized once, hashed for a
 * strong ETag; `If-None-Match` → 304.
 */
export function sendSiteJson<S extends z.ZodType>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: S,
  body: z.input<S>,
  ttlSeconds: number,
) {
  const json = JSON.stringify(schema.parse(body));
  const etag = etagFor(json);
  reply
    .header('Cache-Control', SITE_CACHE_POLICY.cacheControl(ttlSeconds))
    .header('ETag', etag)
    .header('Vary', SITE_CACHE_POLICY.vary);
  if (weakCompareEtag(req.headers['if-none-match'], etag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(json);
}

/** Headers a browser may send to the website API, and read back. */
const ALLOW_HEADERS = 'X-Api-Key, If-None-Match, Content-Type';
const EXPOSE_HEADERS = 'ETag';

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
      if (typeof vary !== 'string' || !/\borigin\b/i.test(vary)) {
        reply.header('Vary', vary ? `${vary}, Origin` : 'Origin');
      }
    }
    return payload;
  });
}
