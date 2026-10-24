import { gunzipSync } from 'node:zlib';
import { CreateListingBody, type CreateSiteInput, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { countQueries, createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { configureHmacRotation } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Per-site XML feeds over HTTP (S7-07): `GET /v2/feeds/{token}/{file}` — no API key (the token URL is the credential),
 * gzip for the CDN and decompressed for clients without it, a strong ETag per file and encoding, public for the CDN
 * only with the edge cache on (keyed by the URL alone: `Vary: Accept-Encoding`), never indexed, unknown and rotated
 * tokens 404 and never stored. Object storage is the platform's memory store.
 */

const RUN = newId().slice(-8);
/** Identities the limiter was asked about, per rule (the per-token rule must never see the token). */
const limited: { rule: string; identity: string }[] = [];
const allow = {
  consume: async (rule: { name: string }, identity: string) => {
    limited.push({ rule: rule.name, identity });
    return { allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 };
  },
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

let edge: Awaited<ReturnType<typeof buildApp>>;
let origin: Awaited<ReturnType<typeof buildApp>>;
let a: Founder;
let siteId = '';
let token = '';

const asMember = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

const SITE: CreateSiteInput = {
  name: 'Feed Homes',
  domains: ['www.feed-homes.example'],
  mode: 'WIDGET',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: 'FH',
  locales: ['en'],
  contact: null,
};

const app = (edgeCache: boolean) =>
  buildApp({
    logger: createLogger({ service: 'feed-api-test', level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    checks: {},
    limiter: allow,
    edgeCache,
  });

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:feed-xml:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websites.configureSiteFeeds({ tokenKey: 'test-hmac-key-0123456789abcdef0123456789' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-key-0123456789abcdef0123456789' });
  configureStorage(createMemoryStore());
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  const ids = await withSystem('feed-api.feeds.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-fx-${RUN}` }];
    const c = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `fx-${RUN}`,
      translations: name('Feedia'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: c,
        code: `fx-r-${RUN}`,
        translations: name('Bay'),
      }),
      code: `fx-c-${RUN}`,
      translations: name('Cove'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: `fx-g-${RUN}`, sort: 0, translations: name('H') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `fx-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const { id } = await asMember(a, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 50_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await asMember(a, async (ctx) =>
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
  await withSystem('feed-api.feeds.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  siteId = (await asMember(a, (ctx) => websites.createSite(ctx, SITE))).id;
  token = (await asMember(a, (ctx) => websites.rotateSiteFeed(ctx, { siteId }))).secret.token;
  await websiteApi.generateSiteFeed(siteId);
  [edge, origin] = [await app(true), await app(false)];
}, 180_000);

afterAll(async () => {
  await edge?.close();
  await origin?.close();
  await closeCache();
  await closeDb();
});

describe('GET /v2/feeds/{token}/{file} (S7-07)', () => {
  it('[S7-07] serves the Kyero and generic feeds by token URL: gzip or plain, strong ETag, 304, never indexed', async () => {
    const gz = await edge.inject({
      method: 'GET',
      url: `/v2/feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(gz.statusCode).toBe(200);
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(gz.headers['x-robots-tag']).toBe('noindex, nofollow');
    const kyero = gunzipSync(gz.rawPayload).toString('utf8');
    expect(kyero).toContain('<feed_version>3</feed_version>');
    expect(kyero.match(/<property>/g)).toHaveLength(1);

    const plain = await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(kyero);
    expect(plain.headers.etag).not.toBe(gz.headers.etag);

    const again = await edge.inject({
      method: 'GET',
      url: `/v2/feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(gz.headers.etag) },
    });
    expect(again.statusCode).toBe(304);

    const generic = await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/inmolink.xml` });
    expect(generic.statusCode).toBe(200);
    expect(generic.body).toContain('<inmolink_feed version="1"');
    expect(generic.body).toContain('ref="');
  });

  it('[S11-F13] after an HMAC_KEY rotation a feed URL issued under the previous key resolves until the window ends', async () => {
    const OLD = 'test-hmac-key-0123456789abcdef0123456789';
    const NEW = 'test-hmac-key-rotated-0123456789abcdef01';
    const get = async () => (await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` })).statusCode;
    try {
      websites.configureSiteFeeds({ tokenKey: NEW });
      // No window: the old URL's hash is not the new key's.
      expect(await get()).toBe(404);
      // The window (HMAC_KEY_PREVIOUS = the old key): the URL issued under it still resolves.
      configureHmacRotation({ current: NEW, previous: OLD, previousUntil: new Date(Date.now() + 3_600_000) });
      expect(await get()).toBe(200);
      // The window ends at HMAC_KEY_PREVIOUS_UNTIL…
      configureHmacRotation({ current: NEW, previous: OLD, previousUntil: new Date(Date.now() - 1) });
      expect(await get()).toBe(404);
      // …or when the previous key is removed from config.
      configureHmacRotation({ current: NEW, previous: OLD });
      expect(await get()).toBe(200);
      configureHmacRotation({ current: NEW });
      expect(await get()).toBe(404);
    } finally {
      configureHmacRotation({ current: NEW });
      websites.configureSiteFeeds({ tokenKey: OLD });
    }
    expect(await get()).toBe(200);
  });

  it('[S7-07] served via the CDN with the edge cache on (URL-keyed, site and feed tags); private while it is off', async () => {
    const res = await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
    // A short stale-if-error: a revoked or rotated token's copy never outlives a failed purge by a day.
    expect(res.headers['cache-control']).toBe(
      `public, max-age=0, s-maxage=${websiteApi.SITE_FEED_TTL}, stale-while-revalidate=${websiteApi.SITE_FEED_TTL}, stale-if-error=${websiteApi.SITE_FEED_STALE_IF_ERROR}`,
    );
    expect(websiteApi.SITE_FEED_STALE_IF_ERROR).toBeLessThanOrEqual(300);
    // The token is in the URL: nothing else varies (the cache rule bypasses any other Vary header).
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(String(res.headers['cache-tag']).split(',')).toEqual([
      websiteApi.edgeTag('s', siteId),
      websiteApi.edgeTag('f', siteId),
    ]);
    // Edge cache off: private — S10-F9: a body is never served from the origin, the poll goes to the signed URL.
    const off = await origin.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
    expect(off.statusCode).toBe(302);
    expect(off.headers['cache-control']).toBe('private, no-store');
    expect(off.headers['cache-tag']).toBeUndefined();
  });

  it('[S8-F2] a feed URL with any query parameter is private (one CDN entry per token URL)', async () => {
    // (A bare trailing `?` is covered in `plugins/edge-cache.test.ts`: `inject` drops it before the route.)
    for (const url of [`/v2/feeds/${token}/kyero.xml?x=1`, `/v2/feeds/${token}/kyero.xml?x=1&x=2`]) {
      const res = await edge.inject({ method: 'GET', url });
      // Private, so (S10-F9) redirected to the signed URL like any poll the CDN does not answer.
      expect(res.statusCode, url).toBe(302);
      expect(res.headers['cache-control'], url).toBe('private, no-store');
      expect(res.headers['cache-tag'], url).toBeUndefined();
    }
  });

  it('[S7-07] a rotated, revoked or unknown token answers 404 — never stored by a cache', async () => {
    const rotated = (await asMember(a, (ctx) => websites.rotateSiteFeed(ctx, { siteId }))).secret;
    for (const url of [
      `/v2/feeds/${token}/kyero.xml`,
      `/v2/feeds/${'A'.repeat(43)}/kyero.xml`,
      `/v2/feeds/${rotated.token}/other.xml`,
      '/v2/feeds/short/kyero.xml',
    ]) {
      const res = await edge.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.headers['cache-control'], url).toBe('private, no-store');
      expect(res.headers['cache-tag'], url).toBeUndefined();
    }
    expect((await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` })).json()).toMatchObject({
      error: { code: 'SITE_FEED_NOT_FOUND' },
    });
    expect((await edge.inject({ method: 'GET', url: `/v2/feeds/${rotated.token}/kyero.xml` })).statusCode).toBe(200);
    token = rotated.token;
  });

  it('[S7-07] cache misses are rate-limited per token (a hash of it) and per IP', async () => {
    limited.length = 0;
    await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
    const perToken = limited.filter((l) => l.rule === 'feed.xml.token');
    expect(perToken).toHaveLength(1);
    expect(perToken[0]?.identity).toMatch(/^feed:[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(limited)).not.toContain(token);
    expect(limited.some((l) => l.rule === 'feed.xml.ip')).toBe(true);
  });

  it('[S8-F1] with the edge cache off, gzip polls are redirected to a short-lived signed storage URL', async () => {
    const res = await origin.inject({
      method: 'GET',
      url: `/v2/feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['cache-tag']).toBeUndefined();
    // The memory store's signed URL: the stored gzip object, served as gzip-encoded XML, expiring in a minute.
    const location = String(res.headers.location);
    expect(location.startsWith(`memory://feeds/site-feeds/${siteId}/`)).toBe(true);
    expect(location).toContain('/kyero.xml.gz?');
    // S10-F2: one redirect TTL for site and portal feeds, 60 s.
    expect(location).toMatch(/[?&]expires=60(&|$)/);
    expect(location).toContain('type=application%2Fxml');
    expect(location).toContain('encoding=gzip');
    expect(location).not.toContain(token);
    expect(res.rawPayload.byteLength).toBe(0);
    // A current copy still answers 304 without a redirect; S10-F9: a client without gzip is redirected too (feed-api
    // never gunzips a whole feed per poll).
    const again = await origin.inject({
      method: 'GET',
      url: `/v2/feeds/${token}/kyero.xml`,
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(res.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
    const plain = await origin.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
    expect(plain.statusCode).toBe(302);
    expect(plain.headers['cache-control']).toBe('private, no-store');
    expect(String(plain.headers.location).startsWith(`memory://feeds/site-feeds/${siteId}/`)).toBe(true);
  });

  it('[S8-F1] the feed route stays within 3 queries, warm and cold', async () => {
    const get = async () => {
      const res = await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
      expect(res.statusCode).toBe(200);
    };
    // Cold: the site's scope in no cache.
    await cache.delete(websites.siteCacheKey(siteId));
    cache.clearLocal();
    expect(await countQueries(get)).toBeLessThanOrEqual(3);
    expect(await countQueries(get)).toBeLessThanOrEqual(1);
  });

  it('[S7-07] a feed request costs at most 3 statements (token lookup + the site scope on a cache miss)', async () => {
    const n = await countQueries(async () => {
      const res = await edge.inject({ method: 'GET', url: `/v2/feeds/${token}/kyero.xml` });
      expect(res.statusCode).toBe(200);
    });
    expect(n).toBeLessThanOrEqual(3);
  });
});
