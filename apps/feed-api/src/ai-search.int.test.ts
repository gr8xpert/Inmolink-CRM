import { CreateListingBody, UpdateListingBody, WebsiteAiSearchPage } from '@inmolink/contracts';
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
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { edgeKeyToken } from './plugins/api-key';

/**
 * `GET /v2/search/ai` over HTTP (S12-08): the feed-api contract — key-bound site, strong ETag + 304, a CDN-cacheable
 * answer only when the AI understood the sentence (a keyword fallback stays private), OpenAPI.
 */

const RUN = newId().slice(-8).toLowerCase();
/** The run id in letters only (a place name is letters, blanks and - ' .). */
const TAG = RUN.replace(/[^a-z]/g, (c) => 'abcdefghijklmnopqrstuvwxyz'[c.charCodeAt(0) % 26] as string);
/** Every miss allowed (the miss limits have their own core tests). */
const allowMisses = {
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;
const configure = (parser: websiteApi.AiSearchParser) =>
  websiteApi.configureAiSearch({ parser, limiter: () => allowMisses, cacheReady: () => true });
/** The website limits each request was checked against (`requireApiKey`), newest last. */
const limitChecks: { rule: { name: string }; distinct?: string }[][] = [];
const allow = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly { rule: { name: string }; distinct?: string }[]) => {
    limitChecks.push([...checks]);
    return checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 }));
  },
} as unknown as RateLimiter;

let app: Awaited<ReturnType<typeof buildApp>>;
let founder: Founder;
let key: string;
/** A browser widget's key (publishable, the site's origin): browsers get the per-browser paging rules. */
let widgetKey: string;
const ORIGIN = 'https://www.ai-site.example';
let villa: string;
let city: string;
/** A second listing, outside the city: the site has two (a listings cursor exists). */
let country: string;

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);

const EMPTY = {
  transaction: null,
  newBuild: null,
  types: [],
  features: [],
  places: [],
  bedsMin: null,
  bathsMin: null,
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  reference: null,
  sort: null,
};

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:feed-ai:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  websiteApi.configureEdgeCache({ tagKey: 'test-hmac-key-0123456789abcdef0123456789' });
  // The engine is unreachable here: website search answers from the Postgres fallback.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  ({ villa, city, country } = await withSystem('feed-api.ai-search.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `fai-${n.toLowerCase()}-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `fai-${RUN}`,
      translations: name('Ailand'),
    });
    const c = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: `fai-r-${RUN}`,
        translations: name('Coast'),
      }),
      code: `fai-c-${RUN}`,
      translations: [{ locale: 'en', name: `Epsilon ${TAG}`, slug: `fai-epsilon-${RUN}` }],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `fai-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const v = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `fai-v-${RUN}`,
      sort: 0,
      translations: [{ locale: 'en', name: 'Villa', slug: `fai-villa-${RUN}` }],
    });
    return { villa: v, city: c, country };
  }));
  await taxonomy.invalidateTaxonomyCache();
  const listingIds: string[] = [];
  for (const locationId of [city, country]) {
    const { id } = await as((ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({ propertyTypeId: villa, locationId, priceCents: 30_000_000, energyRating: 'B' }),
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
    listingIds.push(id);
  }
  await withSystem('feed-api.ai-search.test', (tx) => search.rebuildReadModels(tx, 'LISTING', listingIds));
  const site = await as((ctx) =>
    websites.createSite(ctx, {
      name: 'AI site',
      domains: ['www.ai-site.example'],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_ONLY',
      inventoryFilters: null,
      referencePrefix: 'AS',
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
        scopes: ['listings:read'],
        allowedOrigins: [ORIGIN],
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
    edgeCache: true,
  });
}, 180_000);

afterEach(() => websiteApi.configureAiSearch(undefined));

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { 'x-api-key': key, ...headers } });

describe('GET /v2/search/ai (S12-08)', () => {
  it('[S12-08] understood sentences: filters + cards, strong ETag and 304, public for the CDN with the key token', async () => {
    configure({ parse: async () => ({ ...EMPTY, types: ['villa'], places: [`Epsilon ${TAG}`] }) });
    const k = edgeKeyToken(key);
    // The query in its one written form (`URLSearchParams`), as the SDK writes it: otherwise another CDN entry.
    const url = `/v2/search/ai?${new URLSearchParams({ q: `villa in epsilon ${RUN}`, _k: k })}`;
    const res = await get(url);
    expect(res.statusCode, res.body).toBe(200);
    const body = WebsiteAiSearchPage.parse(res.json());
    expect(body.understood.source).toBe('AI');
    expect(body.understood.filters).toMatchObject({ types: expect.arrayContaining([villa]), locations: [city] });
    expect(body.items).toHaveLength(1);
    expect(res.headers.etag).toMatch(/^"/);
    expect(res.headers['cache-control']).toMatch(/^public, .*s-maxage=\d+/);
    expect(res.headers['cache-control']).toContain('stale-if-error=86400');
    const again = await get(url, { 'if-none-match': res.headers.etag as string });
    expect(again.statusCode).toBe(304);
    // Without the key token: private (ETag revalidation only), like `/v2/listings`.
    const plain = await get(`/v2/search/ai?q=${encodeURIComponent(`villa in epsilon ${RUN}`)}`);
    expect(plain.headers['cache-control']).toMatch(/^private/);
  });

  it('[S12-08] a keyword fallback (AI out of budget) answers 200, CDN-cached for 30 s only', async () => {
    configure({
      parse: async () => {
        throw new AppError('AI_BUDGET_EXCEEDED');
      },
    });
    const res = await get(
      `/v2/search/ai?${new URLSearchParams({ q: `epsilon ${RUN} budget`, _k: edgeKeyToken(key) })}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().understood).toMatchObject({ source: 'KEYWORD', filters: { q: `epsilon ${RUN} budget` } });
    expect(res.headers['cache-control']).toMatch(/^public, .*s-maxage=30,/);
    expect(res.headers.etag).toBeDefined();
  });

  it('[S12-08] AI-search pages count towards the same deep-paging and filter-slicing budgets as /v2/listings', async () => {
    configure({ parse: async () => ({ ...EMPTY, types: ['villa'], places: [`Epsilon ${TAG}`] }) });
    limitChecks.length = 0;
    await get(`/v2/search/ai?${new URLSearchParams({ q: `Villa in Epsilon ${RUN}!` })}`);
    await get(`/v2/search/ai?${new URLSearchParams({ q: `villa  in epsilon ${RUN}` })}`);
    const slices = limitChecks.map((checks) => checks.find((c) => c.rule.name.startsWith('feed.slice.key'))?.distinct);
    // A first page is a slice; respellings of one sentence are one slice.
    expect(slices[0]).toBe(`search-ai|q=villa in epsilon ${RUN}`);
    expect(slices[1]).toBe(slices[0]);
    // A browser's cursor page counts as paged (the per-browser paging rules), like a listings cursor page.
    const widget = { 'x-api-key': widgetKey, origin: ORIGIN };
    const first = await get(
      `/v2/search/ai?${new URLSearchParams({ q: `villa in epsilon ${RUN}`, limit: '1' })}`,
      widget,
    );
    expect(first.statusCode).toBe(200);
    expect(limitChecks.flat().some((c) => c.rule.name === 'feed.slice.browser')).toBe(true);
    // The site has two listings: a keyword-searched sentence ("villa") pages; its next page is a cursor page.
    configure({ parse: async () => ({ ...EMPTY, types: ['villa'] }) });
    const all = await get(`/v2/search/ai?${new URLSearchParams({ q: `any villa ${RUN}`, limit: '1' })}`, widget);
    const cursor = all.json().nextCursor as string;
    expect(cursor).toBeTruthy();
    limitChecks.length = 0;
    const next = await get(
      `/v2/search/ai?${new URLSearchParams({ q: `any villa ${RUN}`, limit: '1', cursor })}`,
      widget,
    );
    expect(next.statusCode).toBe(200);
    expect(limitChecks.flat().some((c) => c.rule.name.startsWith('feed.paging.browser'))).toBe(true);
    // A cursor page is not a slice (only the browser's slicing flag is peeked, nothing counted).
    expect(limitChecks.flat().some((c) => c.rule.name.startsWith('feed.slice') && c.distinct !== undefined)).toBe(
      false,
    );
  });

  it('[S12-08] the query is validated and the route is in the OpenAPI document', async () => {
    expect((await get('/v2/search/ai')).statusCode).toBe(422);
    expect((await get(`/v2/search/ai?q=${'x'.repeat(301)}`)).statusCode).toBe(422);
    expect((await get('/v2/search/ai?q=villa&bogus=1')).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/v2/search/ai?q=villa' })).statusCode).toBe(401);
    const doc = app.swagger() as { paths: Record<string, { get?: { operationId?: string } }> };
    expect(doc.paths['/v2/search/ai']?.get?.operationId).toBe('websiteV2.searchAi');
  });
});
