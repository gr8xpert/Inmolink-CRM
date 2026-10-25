import { fileURLToPath } from 'node:url';
import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiStore } from '@inmolink/platform/ai/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/feed-api/src/app';

/**
 * `GET /v2/search/ai` latency at origin (S12-08 acceptance: p95 < 600 ms uncached, < 150 ms cached; ≤ 3 queries).
 * Requests through feed-api (`app.inject`: key check, the AI step, the site's search, serializer, contract check,
 * ETag) one at a time, against the test Meilisearch (an index of this run's listings).
 *
 * Uncached: every request a new sentence, through the real AI gateway (prompt file, structured output, budget and
 * usage store; gateway timeout 3 s as in feed-api) with a **mocked provider of realistic latency: log-normal, median
 * 600 ms, σ 0.5** (p90 ≈ 1.1 s, p99 ≈ 1.9 s) — a FAST-tier structured answer of ~100 output tokens. The 500 ms request
 * timeout (`SEARCH_AI_TIMEOUT_MS`) answers the slower ones with a keyword search: the fallback rate is reported (about
 * two thirds at this spread; the late answers still fill the cache). Cached: the same sentences again (one Redis read,
 * no provider call) — every one understood. Concurrent: 64 new sentences, 16 at a time — the late calls stay within
 * `maxLateCalls` (32) and the process RSS grows < 128 MB. The search at 2M listings is S7-03's measurement (H4); this
 * one measures what the AI step adds.
 */

const RUN = newId().slice(-8).toLowerCase();
/** The run id in letters only (a place name is letters, blanks and - ' .). */
const TAG = RUN.replace(/[^a-z]/g, (c) => 'abcdefghijklmnopqrstuvwxyz'[c.charCodeAt(0) % 26] as string);
const UID = `t_perf_ai_${RUN.replace(/[^a-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });
const LISTINGS = 40;
const REQUESTS = 40;
const UNCACHED_BUDGET_MS = 600;
const CACHED_BUDGET_MS = 150;
/** Log-normal provider latency (ms): median and σ of its log. */
const PROVIDER = { medianMs: 600, sigma: 0.5, maxMs: 2_800 };
const MAX_LATE_CALLS = 32;
const CONCURRENT = { sentences: 64, parallel: 16 };
/** A standard normal draw (Box–Muller). */
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const providerMs = () => Math.min(PROVIDER.maxMs, PROVIDER.medianMs * Math.exp(PROVIDER.sigma * gauss()));

const allow = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

let app: Awaited<ReturnType<typeof buildApp>>;
let a: Founder;
let key: string;
let ids: { city: string; villa: string };
const provider = new FakeProvider();
const log = createLogger({ service: 'perf', level: 'info' });

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.search-ai', fn);

const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.ceil(xs.length * 0.95) - 1] as number;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: `t:perf-ai:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const tr = (n: string) => [{ locale: 'en', name: n, slug: `pai-${n.toLowerCase().replace(/\W+/g, '-')}-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `pai-${RUN}`,
      translations: tr(`Perfland ${RUN}`),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `pai-r-${RUN}`,
      translations: tr(`Coast ${RUN}`),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `pai-c-${RUN}`,
      translations: tr(`Zeta ${TAG}`),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `pai-g-${RUN}`,
      sort: 0,
      translations: tr('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `pai-v-${RUN}`,
      sort: 0,
      translations: tr('Villa'),
    });
    return { city, villa };
  });
  await taxonomy.invalidateTaxonomyCache();
  const created: string[] = [];
  for (let i = 0; i < LISTINGS; i++) {
    const { id } = await as((ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 20_000_000 + i * 1_000_000,
          bedrooms: 1 + (i % 5),
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
    created.push(id);
  }
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', created));
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: created });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  search.resetSearchBreaker();
  const site = await as((ctx) =>
    websites.createSite(ctx, {
      name: 'Perf AI',
      domains: ['www.perf-ai.example'],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_ONLY',
      inventoryFilters: null,
      referencePrefix: 'PA',
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

  // The real gateway (prompt file, JSON schema, budget check and usage record) over a provider with realistic latency.
  provider.respondWith((req) => {
    const beds = /(\d) bed/.exec(req.user)?.[1];
    return JSON.stringify({
      transaction: null,
      newBuild: null,
      types: ['villa'],
      features: [],
      places: [`Zeta ${TAG}`],
      bedsMin: beds ? Number(beds) : null,
      bathsMin: null,
      priceMin: null,
      priceMax: null,
      areaMin: null,
      areaMax: null,
      reference: null,
      sort: null,
    });
  });
  const complete = provider.complete.bind(provider);
  provider.complete = async (request, options) => {
    await sleep(providerMs());
    return complete(request, options);
  };
  configureAi(
    createAiGateway({
      provider,
      models: { FAST: 'fast-model', SMART: 'smart-model' },
      pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 4, output: 20 } },
      batchDiscountBp: 5_000,
      prompts: filePromptSource(fileURLToPath(new URL('../../packages/core/prompts', import.meta.url))),
      cache: null,
      cacheTtlSeconds: 0,
      store: memoryAiStore(),
      budgetFor: () => ({ softMicroUsd: 50_000_000, hardMicroUsd: 100_000_000 }),
      timeoutMs: 3_000,
      breaker: { failures: 50, openMs: 30_000 },
      logger: createLogger({ service: 'ai', level: 'silent' }),
    }),
  );
  websiteApi.configureAiSearch({
    timeoutMs: 500,
    maxLateCalls: MAX_LATE_CALLS,
    limiter: () => allow,
    cacheReady: () => true,
  });
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allow,
    checks: {},
  });
}, 600_000);

afterAll(async () => {
  websiteApi.configureAiSearch(undefined);
  configureAi(undefined);
  await app?.close();
  await real()
    .dropIndex(UID)
    .catch(() => undefined);
  await closeCache();
  await closeDb();
});

const ask = (q: string) =>
  app.inject({ method: 'GET', url: `/v2/search/ai?${new URLSearchParams({ q })}`, headers: { 'x-api-key': key } });

it('[S12-08] p95 < 600 ms uncached and < 150 ms cached, ≤ 3 queries', async () => {
  // Warm the process (site, key, taxonomy and owner caches; the first server build) with one throwaway sentence.
  expect((await ask(`warm villa zeta ${RUN}`)).statusCode).toBe(200);
  const sentences = Array.from({ length: REQUESTS }, (_, i) => `${1 + (i % 5)} bed villa in zeta ${RUN} no ${i}`);
  const timed = async () => {
    const ms: number[] = [];
    let maxQueries = 0;
    let keyword = 0;
    for (const q of sentences) {
      let status = 0;
      let source = '';
      const started = performance.now();
      const statements: string[] = [];
      const queries = await countQueries(
        async () => {
          const res = await ask(q);
          status = res.statusCode;
          source = res.json().understood.source;
        },
        { onQuery: (text) => statements.push(text.replace(/\s+/g, ' ').slice(0, 90)) },
      );
      ms.push(performance.now() - started);
      maxQueries = Math.max(maxQueries, queries);
      if (queries > 3) log.warn({ q, source, queries, statements }, 'over the query budget');
      expect(status).toBe(200);
      if (source !== 'AI') keyword++;
    }
    return { p95: p95(ms), maxQueries, keyword, mean: ms.reduce((x, y) => x + y, 0) / ms.length };
  };
  // Baseline in the same run: `/v2/listings` with the filters the sentences are understood as (no AI step).
  const base: number[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    const qs = new URLSearchParams({ types: ids.villa, locations: ids.city, bedsMin: String(1 + (i % 5)) });
    const started = performance.now();
    expect(
      (await app.inject({ method: 'GET', url: `/v2/listings?${qs}`, headers: { 'x-api-key': key } })).statusCode,
    ).toBe(200);
    base.push(performance.now() - started);
  }
  const callsBefore = provider.calls.length;
  const uncached = await timed();
  expect(provider.calls.length - callsBefore).toBe(REQUESTS);
  // A timed-out request's late answer lands in the cache too: wait for the last ones.
  for (let i = 0; i < 60 && websiteApi.aiSearchLateCalls() > 0; i++) await sleep(100);
  const cached = await timed();
  expect(provider.calls.length - callsBefore).toBe(REQUESTS); // no provider call when cached
  log.info(
    {
      listings: LISTINGS,
      baselineListingsP95: Math.round(p95(base)),
      requests: REQUESTS,
      provider: PROVIDER,
      uncached: {
        p95: Math.round(uncached.p95),
        mean: Math.round(uncached.mean),
        queries: uncached.maxQueries,
        keywordFallbacks: uncached.keyword,
        fallbackRate: Math.round((uncached.keyword / REQUESTS) * 100) / 100,
      },
      cached: { p95: Math.round(cached.p95), mean: Math.round(cached.mean), queries: cached.maxQueries },
    },
    '[S12-08] /v2/search/ai latency',
  );
  expect(cached.keyword).toBe(0);
  // Late answers filled the cache: what timed out uncached is understood now. The rate itself is the provider's.
  expect(uncached.keyword).toBeLessThan(REQUESTS);
  expect(uncached.p95).toBeLessThan(UNCACHED_BUDGET_MS);
  expect(cached.p95).toBeLessThan(CACHED_BUDGET_MS);
  expect(uncached.maxQueries).toBeLessThanOrEqual(3);
  expect(cached.maxQueries).toBeLessThanOrEqual(3);
}, 600_000);

it('[S12-08] concurrent misses: late model calls stay within maxLateCalls, RSS bounded', async () => {
  const sentences = Array.from({ length: CONCURRENT.sentences }, (_, i) => `concurrent villa zeta ${RUN} n ${i}`);
  const rssBefore = process.memoryUsage().rss;
  let maxLate = 0;
  const poll = setInterval(() => {
    maxLate = Math.max(maxLate, websiteApi.aiSearchLateCalls());
  }, 10);
  const ms: number[] = [];
  let keyword = 0;
  try {
    for (let i = 0; i < sentences.length; i += CONCURRENT.parallel) {
      await Promise.all(
        sentences.slice(i, i + CONCURRENT.parallel).map(async (q) => {
          const started = performance.now();
          const res = await ask(q);
          ms.push(performance.now() - started);
          expect(res.statusCode).toBe(200);
          if (res.json().understood.source !== 'AI') keyword++;
        }),
      );
    }
    for (let i = 0; i < 60 && websiteApi.aiSearchLateCalls() > 0; i++) await sleep(100);
  } finally {
    clearInterval(poll);
  }
  const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / 1_048_576;
  log.info(
    {
      sentences: CONCURRENT.sentences,
      parallel: CONCURRENT.parallel,
      p95: Math.round(p95(ms)),
      keywordFallbacks: keyword,
      maxLateCalls: maxLate,
      rssGrowthMb: Math.round(rssGrowthMb),
      rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
    },
    '[S12-08] /v2/search/ai concurrent',
  );
  expect(maxLate).toBeLessThanOrEqual(MAX_LATE_CALLS);
  expect(websiteApi.aiSearchLateCalls()).toBe(0);
  expect(rssGrowthMb).toBeLessThan(128);
}, 600_000);
