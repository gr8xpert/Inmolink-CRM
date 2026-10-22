import * as websiteApi from '@inmolink/core/modules/website-api';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { EDGE_CACHE_RULES, type EdgeCacheRule, edgePublic, publicCacheControl, ruleOf } from './edge-cache';

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

/** A request as `edgePublic` reads it. */
const req = (url: string, edgeCache: boolean, edgeKeyToken: string | null = 'tok') =>
  ({ url, edgeKeyToken, server: { websiteEdgeCache: edgeCache } }) as unknown as FastifyRequest;

describe('edge-cache rules (S8-F2)', () => {
  it('[S8-F2] one table pins the edge-cache policy of every /v2 GET route', async () => {
    const T = websiteApi.WEBSITE_API_TTL;
    const keyed = (ttl: number) => `key ${ttl}s sie=86400 cursor:no params:schema`;
    const pin = (r: EdgeCacheRule) =>
      `${r.gate}${r.sMaxAge === null ? '' : ` ${r.sMaxAge}s`} sie=${r.staleIfError} cursor:${r.cursorPages ? 'yes' : 'no'} params:${r.params === null ? 'schema' : `[${r.params.join(',')}]`}`;
    const taxonomy = 'always 600s sie=86400 cursor:yes params:[lang,cursor,_k]';
    expect(Object.fromEntries(Object.entries(EDGE_CACHE_RULES).map(([route, rule]) => [route, pin(rule)]))).toEqual({
      '/v2/listings': keyed(T.listings),
      '/v2/listings/:ref': keyed(T.detail),
      '/v2/changes': 'never sie=0 cursor:no params:schema',
      '/v2/sitemap': keyed(T.sitemap),
      '/v2/developments': keyed(T.developments),
      '/v2/developments/:ref': keyed(T.development),
      '/v2/developments/:ref/units': keyed(T.units),
      '/v2/taxonomy/locations': taxonomy,
      '/v2/taxonomy/locations/:id/children': taxonomy,
      '/v2/taxonomy/catalog': taxonomy,
      '/v2/taxonomy/types': taxonomy,
      '/v2/taxonomy/features': taxonomy,
      '/v2/feeds/:token/:file': `url ${websiteApi.SITE_FEED_TTL}s sie=${websiteApi.SITE_FEED_STALE_IF_ERROR} cursor:no params:[]`,
    });
    expect(publicCacheControl(EDGE_CACHE_RULES['/v2/taxonomy/catalog'])).toBe(
      'public, max-age=0, s-maxage=600, stale-while-revalidate=600, stale-if-error=86400',
    );
    expect(() => publicCacheControl(EDGE_CACHE_RULES['/v2/changes'])).toThrow();

    // Every GET route the app serves under /v2 has its row, and every row is a served route.
    const app = await buildApp({
      logger: createLogger({ level: 'silent' }),
      trustProxy: 1,
      docsUi: false,
      limiter: allowAll,
      checks: {},
    });
    try {
      await app.ready();
      const spec = app.swagger() as { paths: Record<string, Record<string, unknown>> };
      const served = Object.entries(spec.paths)
        .filter(([path, ops]) => path.startsWith('/v2/') && 'get' in ops)
        .map(([path]) => path.replace(/\{(\w+)\}/g, ':$1'))
        .sort();
      expect(served).toEqual(Object.keys(EDGE_CACHE_RULES).sort());
    } finally {
      await app.close();
    }
  }, 30_000);

  it('[S8-F2] edgePublic applies a rule: flag, _k, cursor pages and unknown parameters', () => {
    const listings = EDGE_CACHE_RULES['/v2/listings'];
    expect(edgePublic(req('/v2/listings?lang=en&_k=tok', true), listings)).toBe(true);
    expect(edgePublic(req('/v2/listings?lang=en&_k=tok', false), listings)).toBe(false);
    expect(edgePublic(req('/v2/listings?lang=en', true), listings)).toBe(false);
    expect(edgePublic(req('/v2/listings?_k=tok&_k=tok', true), listings)).toBe(false);
    expect(edgePublic(req('/v2/listings?_k=other', true), listings)).toBe(false);
    expect(edgePublic(req('/v2/listings?_k=tok&cursor=', true), listings)).toBe(false);
    expect(edgePublic(req('/v2/changes?_k=tok', true), EDGE_CACHE_RULES['/v2/changes'])).toBe(false);

    const taxonomy = EDGE_CACHE_RULES['/v2/taxonomy/locations'];
    // The same for every key: public whatever the flag, cursor pages included, no other parameter.
    expect(edgePublic(req('/v2/taxonomy/locations?lang=en&cursor=x', false, null), taxonomy)).toBe(true);
    expect(edgePublic(req('/v2/taxonomy/locations?lang=en&bust=1', false, null), taxonomy)).toBe(false);

    const feed = EDGE_CACHE_RULES['/v2/feeds/:token/:file'];
    expect(edgePublic(req('/v2/feeds/t/kyero.xml', true, null), feed)).toBe(true);
    expect(edgePublic(req('/v2/feeds/t/kyero.xml', false, null), feed)).toBe(false);
    expect(edgePublic(req('/v2/feeds/t/kyero.xml?bust=1', true, null), feed)).toBe(false);
  });

  it('[S8-F2] a query in any other written form than its own is private: encodings, blanks, repeats, a random _k', () => {
    const listings = EDGE_CACHE_RULES['/v2/listings'];
    const taxonomy = EDGE_CACHE_RULES['/v2/taxonomy/catalog'];
    const feed = EDGE_CACHE_RULES['/v2/feeds/:token/:file'];
    expect(edgePublic(req('/v2/listings?transaction=SALE&_k=tok', true), listings)).toBe(true);
    expect(edgePublic(req('/v2/listings?locations=a%2Cb&_k=tok', true), listings)).toBe(true); // as the SDK writes it
    for (const url of [
      '/v2/listings?transaction=%53ALE&_k=tok',
      '/v2/listings?%74ransaction=SALE&_k=tok',
      '/v2/listings?transaction=SALE+&_k=tok',
      '/v2/listings?transaction=SALE%20%20&_k=tok',
      '/v2/listings?priceMin=%31000&_k=tok',
      '/v2/listings?locations=a,b&_k=tok',
      '/v2/listings?transaction=SALE&transaction=SALE&_k=tok',
    ]) {
      expect(edgePublic(req(url, true), listings), url).toBe(false);
    }
    expect(edgePublic(req('/v2/taxonomy/catalog?lang=en', false), taxonomy)).toBe(true);
    expect(edgePublic(req('/v2/taxonomy/catalog?lang=en&_k=tok', false), taxonomy)).toBe(true); // the caller's own
    for (const url of [
      '/v2/taxonomy/catalog?lang=en&_k=random1',
      '/v2/taxonomy/catalog?lang=en&lang=en',
      '/v2/taxonomy/catalog?lang=e%6E',
      '/v2/taxonomy/catalog?',
    ]) {
      expect(edgePublic(req(url, false), taxonomy), url).toBe(false);
    }
    expect(edgePublic(req('/v2/feeds/t/kyero.xml?', true, null), feed)).toBe(false);
  });

  it('[S8-F2] the rule comes from the matched route, never from the handler', () => {
    const at = (url: string | undefined) => ({ routeOptions: { url } }) as unknown as FastifyRequest;
    expect(ruleOf(at('/v2/listings/:ref'))).toBe(EDGE_CACHE_RULES['/v2/listings/:ref']);
    expect(() => ruleOf(at('/v2/unknown'))).toThrow(/no rule/);
    expect(() => ruleOf(at(undefined))).toThrow(/no rule/);
  });
});
