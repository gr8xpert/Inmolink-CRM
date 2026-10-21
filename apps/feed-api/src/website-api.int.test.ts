import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { WEBSITE_API_TTL } from './routes/website-api/routes';

/** Website API v2 reads over HTTP (S7-03): cache headers, strong ETags and 304s, site-bound keys, OpenAPI. */

const RUN = newId().slice(-8);
const allow = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

let app: Awaited<ReturnType<typeof buildApp>>;
let founder: Founder;
let key: string;
let widgetKey: string;
let ref: string;
let country: string;

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:feed-v2:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  // The engine is unreachable here: website search answers from the Postgres fallback.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  const ids = await withSystem('feed-api.v2.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const c = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `fv-${RUN}`,
      translations: name('Feedland'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: c,
        code: `fv-r-${RUN}`,
        translations: name('Coast'),
      }),
      code: `fv-c-${RUN}`,
      translations: name('Delta'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `fv-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `fv-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { c, city, villa };
  });
  country = ids.c;
  const { id } = await as((ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  await withSystem('feed-api.v2.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  ref = (await as((ctx) => properties.getListing(ctx, id))).ref as string;
  const site = await as((ctx) =>
    websites.createSite(ctx, {
      name: 'Feed site',
      domains: ['www.feed-site.example'],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_ONLY',
      inventoryFilters: null,
      referencePrefix: 'FS',
      locales: ['en'],
      contact: null,
    }),
  );
  key = (
    await as((ctx) =>
      identity.createApiKey(ctx, {
        name: 'WP',
        kind: 'SECRET',
        scopes: ['listings:read'],
        allowedOrigins: [],
        siteId: site.id,
      }),
    )
  ).secret;
  widgetKey = (
    await as((ctx) =>
      identity.createApiKey(ctx, {
        name: 'Widget',
        kind: 'PUBLISHABLE',
        scopes: ['listings:read', 'taxonomy:read'],
        allowedOrigins: ['https://www.feed-site.example'],
        siteId: site.id,
      }),
    )
  ).secret;
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allow,
    checks: {},
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { 'x-api-key': key, ...headers } });

describe('website API v2 over HTTP (S7-03)', () => {
  it('[S7-03] ETag + 304 work and site answers are private (no shared cache mixes sites), on every read endpoint', async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const urls: [string, number][] = [
      [`/v2/listings?locations=${country}`, WEBSITE_API_TTL.listings],
      [`/v2/listings/${encodeURIComponent(ref)}?lang=en`, WEBSITE_API_TTL.detail],
      [`/v2/changes?since=${encodeURIComponent(since)}`, WEBSITE_API_TTL.changes],
      ['/v2/sitemap', WEBSITE_API_TTL.sitemap],
    ];
    for (const [url, ttl] of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(ttl).toBeGreaterThan(0);
      // The site comes from the key header and Cloudflare ignores Vary: private until S7-06 keys the CDN by site.
      expect(res.headers['cache-control'], url).toBe('private, max-age=0, must-revalidate');
      expect(res.headers.vary, url).toBe('Accept-Encoding, X-Api-Key, Authorization, Origin');
      const etag = res.headers.etag as string;
      // Strong: a hash of the exact body.
      expect(etag, url).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
      expect(res.headers['content-type'], url).toContain('application/json');
      const again = await get(url, { 'if-none-match': etag });
      expect(again.statusCode, url).toBe(304);
      expect(again.body, url).toBe('');
      expect(again.headers.etag, url).toBe(etag);
      expect((await get(url, { 'if-none-match': '"other"' })).statusCode, url).toBe(200);
    }
    const detail = (await get(`/v2/listings/${encodeURIComponent(ref)}`)).json();
    expect(detail).toMatchObject({ ref, kind: 'LISTING' });
    const page = (await get(`/v2/listings?locations=${country}`)).json();
    expect(page).toMatchObject({ total: 1, degraded: true });
    expect(page.items[0].ref).toBe(ref);
  });

  it('[S7-03] unknown references, other languages and bad cursors are refused clearly', async () => {
    expect((await get('/v2/listings/NOPE-123')).json().error.code).toBe('LISTING_NOT_FOUND');
    expect((await get('/v2/listings?lang=de')).json().error.code).toBe('VALIDATION_FAILED');
    expect((await get('/v2/changes')).json().error.code).toBe('VALIDATION_FAILED');
    expect((await get('/v2/changes?cursor=bm9wZQ')).json().error.code).toBe('VALIDATION_FAILED');
    expect((await get('/v2/listings', { 'x-api-key': 'inl_test_nope' })).statusCode).toBe(401);
  });

  it('[S7-03] browser widgets: preflight, and an allowlisted origin echoed for publishable keys only', async () => {
    const origin = 'https://www.feed-site.example';
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v2/listings',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(origin);
    expect(String(pre.headers['access-control-allow-headers'])).toMatch(/X-Api-Key/i);
    const res = await get('/v2/sitemap', { 'x-api-key': widgetKey, origin });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers.vary).toMatch(/Origin/);
    expect((await get('/v2/sitemap', { 'x-api-key': widgetKey, origin: 'https://evil.example' })).statusCode).toBe(403);
    // Secret keys (server to server) get no CORS header.
    expect((await get('/v2/sitemap')).headers['access-control-allow-origin']).toBeUndefined();
    // Taxonomy is the same for every site: public, shareable by any widget origin.
    const tax = await get('/v2/taxonomy/catalog', { 'x-api-key': widgetKey, origin });
    expect(tax.headers['access-control-allow-origin']).toBe('*');
  });

  it('[S7-03] OpenAPI documents every website API v2 read endpoint', async () => {
    const doc = app.swagger() as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    for (const op of [
      'websiteV2.listListings',
      'websiteV2.getListing',
      'websiteV2.listChanges',
      'websiteV2.getSitemap',
    ]) {
      expect(ops).toContain(op);
    }
  });
});
