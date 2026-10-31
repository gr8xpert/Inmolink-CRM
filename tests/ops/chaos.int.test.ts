import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateListingBody, UpdateListingBody, WebsiteAiSearchQuery, WebsiteListingsQuery } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as agencies from '@inmolink/core/modules/agencies';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder, purgeReferenceFixtures, withSystem } from '@inmolink/core/test';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiStore } from '@inmolink/platform/ai/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { createDispatcher, defineEvent, emit, replayOutboxBatch, SubscriberRegistry } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EDGE_CACHE_RULES, publicCacheControl } from '../../apps/feed-api/src/plugins/edge-cache';
import {
  DrillRecorder,
  type DrillResult,
  evaluateEdgeOutage,
  killContainer,
  percentile,
  secondsSince,
  startContainer,
  startWriteTicker,
  stopContainer,
  THROWAWAY_PREFIX,
  until,
  type WriteTicker,
  waitHealthy,
  writesLost,
} from '../../scripts/ops/chaos';
import { markerJobs } from '../../scripts/ops/chaos-markers';
import { docker, POSTGRES_IMAGE, restoreDrill, TEST_STACK_NETWORK } from '../../scripts/ops/pitr';
import { pendingOf, restartRedisQueue, runSystem } from '../queue/helpers';

/**
 * Chaos drills, local mode (S16-02, PLAN §15, degradation matrix §5.4). Each drill injects its fault into the docker
 * `test` stack — Meilisearch stopped, redis-queue restarted — or into throwaway containers (Postgres primary, standby
 * and the "fresh server": the shared test Postgres is never killed), checks the matrix row's behaviour and measures
 * RTO / RPO. `pnpm ops:drill <drill> --local` runs one; the results go to `CHAOS_REPORT` (JSON) when set and are
 * recorded in docs/build/reviews/chaos-R1.md. What only staging shows is in that file and in `DRILLS[*].stagingOnly`.
 *
 * Disruptions are short (seconds) because other suites share the stack, and every drill restores what it stopped in a
 * `finally`.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const RUN = newId().slice(-8).toLowerCase();
const ALNUM = RUN.replace(/[^a-z0-9]/g, '');
const results: DrillResult[] = [];
const log = createLogger({ service: 'chaos', level: 'silent' });
const MEILI = 'inmolink-meilisearch-test-1';

afterAll(() => {
  const report = process.env.CHAOS_REPORT;
  if (report) writeFileSync(report, `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results) console.info(`[S16-02] drill ${r.drill}: ${r.passed ? 'PASS' : 'FAIL'}`, JSON.stringify(r));
});

const record = (r: DrillRecorder) => {
  const result = r.result();
  results.push(result);
  return result;
};
const failedChecks = (r: DrillResult) => r.checks.filter((c) => !c.ok);

// ---------------------------------------------------------------------------------------------------------------
// Website fixtures (search and AI drills): one agency, a site, three public listings in a run-scoped index.
// ---------------------------------------------------------------------------------------------------------------

const PREFIX = `chaos-${ALNUM}-`;
const code = (s: string) => `${PREFIX}${s}`;
const UID = `t_chaos_${ALNUM}`;
const engine = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });

let founder: Founder;
let siteId = '';
let fixture: { country: string; city: string; villa: string } = { country: '', city: '', villa: '' };
const listingIds: string[] = [];
let websiteReady: Promise<void> | undefined;

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);
const site = () => websiteApi.siteForKey({ agencyId: founder.agencyId, siteId }, newId());
const listings = () =>
  WebsiteListingsQuery.parse({ locations: fixture.country, sort: 'price_asc' }) as WebsiteListingsQuery;

async function createPublicListing(priceCents: number): Promise<string> {
  const { id } = await as((ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: fixture.villa,
        locationId: fixture.city,
        priceCents,
        energyRating: 'B',
        bedrooms: 3,
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
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  await withSystem('chaos.read-models', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return id;
}

/** Once per file: the drills that need a website share it. */
function website(): Promise<void> {
  websiteReady ??= (async () => {
    founder = await createFounder();
    await setAgencyStatus(founder.agencyId, 'VERIFIED');
    fixture = await withSystem('chaos.fixtures', async (tx) => {
      const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
      const country = await taxonomy.createLocation(tx, {
        level: 'COUNTRY',
        parentId: null,
        code: code('c'),
        translations: tr(`Chaosland ${RUN}`, 'c'),
      });
      const region = await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: code('r'),
        translations: tr(`Chaos Coast ${RUN}`, 'r'),
      });
      const city = await taxonomy.createLocation(tx, {
        level: 'CITY',
        parentId: region,
        code: code('city'),
        translations: tr(`Chaos City ${RUN}`, 'city'),
      });
      const group = await taxonomy.createPropertyTypeGroup(tx, {
        key: code('g'),
        sort: 0,
        translations: tr('Homes', 'g'),
      });
      const villa = await taxonomy.createPropertyType(tx, {
        groupId: group,
        key: code('villa'),
        sort: 0,
        translations: tr('Villa', 'villa'),
      });
      return { country, city, villa };
    });
    await taxonomy.invalidateTaxonomyCache();
    for (const price of [20_000_000, 30_000_000, 40_000_000]) listingIds.push(await createPublicListing(price));
    siteId = (
      await as((ctx) =>
        websites.createSite(ctx, {
          name: 'Chaos Homes',
          domains: [`www.chaos-${ALNUM}.example`],
          mode: 'WP_PLUGIN',
          inventoryPolicy: 'OWN_ONLY',
          inventoryFilters: null,
          referencePrefix: 'CH',
          locales: ['en'],
          contact: null,
        }),
      )
    ).id;
    configureSearch(engine());
    search.configureSearchIndex({ uid: UID, scope: listingIds });
    await search.ensureListingsIndex(engine(), search.listingsIndex(UID));
    await search.syncIndex();
  })();
  return websiteReady;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: `t:chaos:${RUN}` });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
}, 180_000);

afterAll(async () => {
  configureAi(undefined);
  websiteApi.configureAiSearch(undefined);
  search.configureWebsiteSearch({});
  if (websiteReady) {
    await engine()
      .dropIndex(UID)
      .catch(() => undefined);
    if (listingIds.length > 0) {
      const all = sql.join(
        listingIds.map((t) => sql`${t}`),
        sql`, `,
      );
      await withSystem('chaos.cleanup', async (tx) => {
        await tx.execute(sql`delete from search_index_queue where target_id in (${all})`);
        await tx.execute(sql`delete from listing_search_docs where target_id in (${all})`);
        await tx.execute(sql`delete from listing_search_commissions where target_id in (${all})`);
      }).catch(() => undefined);
    }
    await purgeReferenceFixtures(PREFIX).catch(() => undefined);
  }
  await closeQueues().catch(() => undefined);
  await closeCache();
  await closeDb();
}, 120_000);

describe('chaos drills (local)', () => {
  it('[S16-02] kill search: with Meilisearch stopped website search answers from the Postgres fallback (degraded, same results), and switches back by itself once it returns', async () => {
    await website();
    // Production timing, except a 1 s open window so the drill's outage stays short for the shared stack.
    search.configureWebsiteSearch({ engineTimeoutMs: 1_000, slowMs: 800, breakerOpenMs: 1_000 });
    const s = await site();
    const healthy = await until('engine answering the run index', async () => {
      const page = await websiteApi.searchListings(s, listings());
      return !page.degraded && page.items.length === 3 ? page : undefined;
    });
    const expected = healthy.items.map((i) => i.id);
    const r = new DrillRecorder('search', 'local');

    const latencies: number[] = [];
    let errors = 0;
    let firstFallbackAt: number | null = null;
    let sameResults = true;
    let detailOk = false;
    const t0 = Date.now();
    const done = r.disrupt(MEILI, 'docker stop (engine down)');
    await stopContainer(MEILI, {}, 2);
    let restarted = 0;
    try {
      // ~8 s of website traffic with the engine gone.
      while (Date.now() - t0 < 8_000) {
        const t = performance.now();
        try {
          const page = await websiteApi.searchListings(await site(), listings());
          latencies.push(performance.now() - t);
          if (page.degraded) {
            firstFallbackAt ??= Date.now();
            if (JSON.stringify(page.items.map((i) => i.id)) !== JSON.stringify(expected)) sameResults = false;
          }
        } catch {
          errors += 1;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      const ref = healthy.items[0]?.ref as string;
      detailOk = (await websiteApi.listingDetail(await site(), ref)).ref === ref;
    } finally {
      restarted = Date.now();
      await startContainer(MEILI);
      r.measure('engineHealthyAfterStartSeconds', await waitHealthy(MEILI));
      done();
    }
    // Recovery: the breaker probes after its open window and the engine answers again — no restart of anything.
    const recoveredAt = await until(
      'engine back in use',
      async () => ((await websiteApi.searchListings(await site(), listings())).degraded ? undefined : Date.now()),
      60_000,
      250,
    );

    r.check('every search answered while the engine was down (no 5xx)', errors === 0, `${errors} errors`);
    r.check('answers came from the Postgres fallback (degraded: true)', firstFallbackAt !== null);
    r.check('fallback results equal the engine results for basic filters', sameResults);
    r.check('listing detail unaffected', detailOk);
    r.check('engine back in use without a restart', recoveredAt > restarted);
    r.rtoSeconds = firstFallbackAt === null ? null : secondsSince(t0, firstFallbackAt);
    r.measure('timeToFallbackSeconds', r.rtoSeconds ?? -1);
    r.measure('outageSearches', latencies.length);
    r.measure('outageP95Ms', percentile(latencies, 95));
    r.measure('engineDownSeconds', secondsSince(t0, restarted));
    r.measure('recoverySecondsAfterStart', secondsSince(restarted, recoveredAt));
    r.note('rtoSeconds = kill → first answer served by the fallback (website search never failed in between)');
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
  }, 180_000);

  it('[S16-02] kill feed-api origin: every public website answer lets the CDN serve it stale for 24 h; an outage sample is judged as the matrix says', () => {
    const r = new DrillRecorder('feed-origin', 'local');
    const siteRoutes = [
      '/v2/listings',
      '/v2/listings/:ref',
      '/v2/sitemap',
      '/v2/developments',
      '/v2/developments/:ref',
      '/v2/developments/:ref/units',
      '/v2/taxonomy/catalog',
    ] as const;
    for (const route of siteRoutes) {
      const cc = publicCacheControl(EDGE_CACHE_RULES[route]);
      r.check(
        `${route}: public with stale-if-error=86400`,
        /\bpublic\b/.test(cc) && /stale-if-error=86400\b/.test(cc),
        cc,
      );
    }
    // The staging evaluator on the S7-06 model's sequence: warmed URLs HIT then STALE, an unwarmed one fails.
    const ok = evaluateEdgeOutage([
      { atMs: 0, status: 200, cacheStatus: 'HIT', warmed: true },
      { atMs: 70_000, status: 200, cacheStatus: 'STALE', warmed: true },
      { atMs: 70_000, status: 502, cacheStatus: '', warmed: false },
    ]);
    const bad = evaluateEdgeOutage([
      { atMs: 0, status: 200, cacheStatus: 'HIT', warmed: true },
      { atMs: 70_000, status: 502, cacheStatus: 'EXPIRED', warmed: true },
    ]);
    r.check('outage judged: stale answers pass', ok.length === 0, ok.join('; '));
    r.check('outage judged: a warmed URL failing is caught', bad.length === 2, bad.join('; '));
    r.measure('staleIfErrorSeconds', EDGE_CACHE_RULES['/v2/listings'].staleIfError);
    r.note(
      'Behaviour with the origin stopped: apps/feed-api/src/edge-cache.int.test.ts "[S7-06] origin stopped" (Cloudflare model, run by `ops:drill feed-origin --local`). Cloudflare itself: staging (H4).',
    );
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
  });

  it('[S16-02] AI provider returning 100 % errors: listing create, publish, website search and detail are unaffected; AI search answers a keyword search and the gateway fails fast', async () => {
    await website();
    search.configureWebsiteSearch({ engineTimeoutMs: 5_000, slowMs: 4_000 });
    const r = new DrillRecorder('ai-provider', 'local');
    const provider = new FakeProvider().failWith(); // 529 overloaded on every call
    configureAi(
      createAiGateway({
        provider,
        models: { FAST: 'fast-model', SMART: 'smart-model' },
        pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 4, output: 20 } },
        batchDiscountBp: 5_000,
        prompts: filePromptSource(join(ROOT, 'packages', 'core', 'prompts')),
        cache: null,
        cacheTtlSeconds: 0,
        store: memoryAiStore(),
        budgetFor: () => ({ softMicroUsd: 50_000_000, hardMicroUsd: 100_000_000 }),
        timeoutMs: 5_000,
        breaker: { failures: 3, openMs: 30_000 },
        logger: log,
      }),
    );
    const allow: RateLimiter = {
      consumeMany: async (checks: readonly RateLimitCheck[]) =>
        checks.map((c) => ({ allowed: true, limit: c.rule.limit, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
    } as unknown as RateLimiter;
    websiteApi.configureAiSearch({ limiter: () => allow, cacheReady: () => true });
    await agencies.setAgencyAiFeature(as, 'WEBSITE_SEARCH', true);
    const t0 = Date.now();
    try {
      // Core flows: none of them may reach the provider.
      const before = provider.calls.length;
      const coreMs: Record<string, number> = {};
      const timed = async <T>(name: string, fn: () => Promise<T>) => {
        const t = performance.now();
        const out = await fn();
        coreMs[name] = performance.now() - t;
        return out;
      };
      const id = await timed('createAndPublishListing', () => createPublicListing(50_000_000));
      listingIds.push(id);
      search.configureSearchIndex({ uid: UID, scope: listingIds });
      await search.syncIndex();
      const s = await site();
      const page = await timed('websiteSearch', () => websiteApi.searchListings(s, listings()));
      const ref = page.items[0]?.ref as string;
      const detail = await timed('listingDetail', () => websiteApi.listingDetail(s, ref));
      r.check('listing created and published', typeof id === 'string');
      r.check('website search answers', page.items.length >= 3, `${page.items.length} items`);
      r.check('listing detail answers', detail.ref === ref);
      r.check('core flows never called the AI provider', provider.calls.length === before);

      // The AI feature degrades: keyword search, never an error. The breaker opens after 3 failures.
      const aiMs: number[] = [];
      const sources: string[] = [];
      for (let i = 0; i < 6; i++) {
        const t = performance.now();
        const answer = await websiteApi.aiSearch(s, websiteApiQuery(`sunny villa ${i} ${RUN}`), {
          caller: { keyId: newId(), kind: 'SECRET', ip: '203.0.113.0' },
        });
        aiMs.push(performance.now() - t);
        sources.push(answer.understood.source);
      }
      r.check(
        'AI search answers a keyword search every time',
        sources.every((x) => x === 'KEYWORD'),
        sources.join(','),
      );
      r.check(
        'the gateway breaker stops calling a failing provider',
        provider.calls.length - before <= 3,
        `${provider.calls.length - before} provider calls for 6 AI searches`,
      );
      for (const [k, v] of Object.entries(coreMs)) r.measure(`${k}Ms`, v);
      r.measure('aiSearchP95Ms', percentile(aiMs, 95));
      r.measure('providerCalls', provider.calls.length - before);
    } finally {
      configureAi(undefined);
      websiteApi.configureAiSearch(undefined);
      await agencies.setAgencyAiFeature(as, 'WEBSITE_SEARCH', false).catch(() => undefined);
    }
    r.rtoSeconds = 0; // nothing to recover: core flows never stopped
    r.measure('drillSeconds', secondsSince(t0));
    r.note(
      'Not covered: queued AI jobs retrying with backoff (worker side); this drill checks request-path degradation only.',
    );
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
  }, 180_000);
});

function websiteApiQuery(q: string) {
  return WebsiteAiSearchQuery.parse({ q });
}

// ---------------------------------------------------------------------------------------------------------------
// redis-queue: a graceful restart and a crash (docker kill, AOF everysec). Marker jobs queued before, outbox events
// emitted across the outage: every one must run.
// ---------------------------------------------------------------------------------------------------------------

const REDIS_QUEUE = 'inmolink-redis-queue-test-1';

/** docker kill + start; recreated (same volume, so the AOF survives) if Docker Desktop dropped the published port. */
async function crashRedisQueue(): Promise<void> {
  await killContainer(REDIS_QUEUE);
  await startContainer(REDIS_QUEUE);
  const port = await docker(['port', REDIS_QUEUE, '6379/tcp']).catch(() => '');
  if (port === '') {
    await docker(
      ['compose', '--profile', 'test', 'up', '-d', '--wait', '--force-recreate', '--no-deps', 'redis-queue-test'],
      {},
      120_000,
    );
  }
  await waitHealthy(REDIS_QUEUE);
}

describe('chaos drill: redis-queue', () => {
  const AGENCY = newId();
  const restartMarkers = markerJobs(`r${ALNUM}`);
  const crashMarkers = markerJobs(`c${ALNUM}`);
  const restartEvent = defineEvent(`test.r${ALNUM}.restart`, 1, z.object({ agencyId: z.uuid(), key: z.string() }));
  const crashEvent = defineEvent(`test.r${ALNUM}.crash`, 1, z.object({ agencyId: z.uuid(), key: z.string() }));
  const subscribers = new SubscriberRegistry();
  subscribers.add(restartEvent, (p) => restartMarkers.enqueue([p.key]));
  subscribers.add(crashEvent, (p) => crashMarkers.enqueue([p.key]));
  const types = [restartEvent.type, crashEvent.type];

  /** Emits `keys` as outbox events in batches of 10 every 100 ms (commits spread over the outage). */
  async function emitSpread(event: typeof restartEvent, keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 10) {
      await withSystem('chaos.emit', (tx) =>
        emit(
          tx,
          keys.slice(i, i + 10).map((key) => event({ agencyId: AGENCY, key })),
        ),
      );
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  async function deadEvents(type: string): Promise<number> {
    const { rows } = await withSystem('chaos.dead', (tx) =>
      tx.execute(sql`select count(*)::int as n from outbox_events where type = ${type} and dead_at is not null`),
    );
    return Number(rows[0]?.n);
  }

  beforeAll(async () => {
    await configureQueue({ prefix: `chaos-${ALNUM}`, logger: log });
  });
  afterAll(async () => {
    await restartMarkers.close().catch(() => undefined);
    await crashMarkers.close().catch(() => undefined);
    await withSystem('chaos.cleanup', (tx) =>
      tx.execute(
        sql`delete from outbox_events where type in (select jsonb_array_elements_text(${JSON.stringify(types)}::jsonb))`,
      ),
    ).catch(() => undefined);
  }, 60_000);

  it('[S16-02] restart redis-queue: zero lost jobs — jobs queued before and events emitted during the restart all run, none dead-lettered', async () => {
    const r = new DrillRecorder('redis-queue', 'local');
    const queuedKeys = Array.from({ length: 300 }, (_, i) => `q${i}`);
    const outageKeys = Array.from({ length: 100 }, (_, i) => `e${i}`);
    await restartMarkers.enqueue(queuedKeys);
    const dispatcher = createDispatcher({ runSystem, logger: log, subscribers, pollMs: 50, agencyIds: [AGENCY] });
    await dispatcher.start();
    restartMarkers.startWorker(2); // the restart hits jobs waiting, active and done
    const t0 = Date.now();
    const notYetRun = queuedKeys.length - restartMarkers.ran.size;
    const done = r.disrupt(REDIS_QUEUE, 'docker restart (graceful, AOF)');
    const restart = restartRedisQueue().finally(() => done());
    // Events committed while Redis restarts: the outbox (Postgres) holds them until enqueue works again.
    await emitSpread(restartEvent, outageKeys);
    await restart;
    const restartedAt = Date.now();
    const all = [...queuedKeys, ...outageKeys];
    try {
      await until(
        'every job ran',
        async () =>
          restartMarkers.lost(all).length === 0 && (await pendingOf([restartEvent.type])) === 0 ? true : undefined,
        120_000,
        200,
      );
    } finally {
      await dispatcher.stop();
    }
    const drainedAt = Date.now();
    const lost = restartMarkers.lost(all).length;
    const deadJobs = await restartMarkers.deadLetters();
    const dead = await deadEvents(restartEvent.type);
    r.check('the restart hit queued work', notYetRun > 0, `${notYetRun} queued jobs not yet run`);
    r.check('zero lost jobs', lost === 0, `${lost} lost`);
    r.check('no job dead-lettered', deadJobs === 0, `${deadJobs}`);
    r.check('no outbox event dead-lettered', dead === 0, `${dead}`);
    r.rtoSeconds = secondsSince(t0, drainedAt);
    r.measure('redisRestartSeconds', secondsSince(t0, restartedAt));
    r.measure('drainAfterRestartSeconds', secondsSince(restartedAt, drainedAt));
    r.measure('jobs', all.length);
    r.measure('jobsLost', lost);
    r.measure('queuedJobsNotYetRunAtRestart', notYetRun);
    r.measure('eventsEmittedDuringRestart', outageKeys.length);
    r.measure('duplicateRuns', restartMarkers.duplicates());
    r.note('rtoSeconds = restart start → every job and event processed');
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
  }, 240_000);

  it('[S16-02] crash redis-queue (docker kill): jobs queued over a second before the crash survive (AOF everysec); events across the crash all run, after an outbox replay of the window if one was lost', async () => {
    const r = new DrillRecorder('redis-queue', 'local');
    const queuedKeys = Array.from({ length: 300 }, (_, i) => `q${i}`);
    const crashKeys = Array.from({ length: 100 }, (_, i) => `e${i}`);
    await crashMarkers.enqueue(queuedKeys);
    await new Promise((res) => setTimeout(res, 1_500)); // past appendfsync everysec: on disk before the crash
    const dispatcher = createDispatcher({ runSystem, logger: log, subscribers, pollMs: 50, agencyIds: [AGENCY] });
    await dispatcher.start();
    crashMarkers.startWorker(2);
    const windowStart = new Date(Date.now() - 1_000);
    const emitting = emitSpread(crashEvent, crashKeys); // ~1 s of events, the crash in the middle
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    const notYetRun = queuedKeys.length - crashMarkers.ran.size;
    const done = r.disrupt(REDIS_QUEUE, 'docker kill + start (crash; AOF everysec)');
    await crashRedisQueue().finally(() => done());
    const restartedAt = Date.now();
    await emitting;
    const all = [...queuedKeys, ...crashKeys];
    let lostBeforeReplay = 0;
    let replayed = 0;
    try {
      // Stalled jobs (active at the crash) come back after BullMQ's lock expires (30 s): wait past that.
      await until(
        'outbox drained and the queue settled',
        async () =>
          (await pendingOf([crashEvent.type])) === 0 &&
          (crashMarkers.lost(all).length === 0 || Date.now() - restartedAt > 45_000)
            ? true
            : undefined,
        120_000,
        500,
      );
      lostBeforeReplay = crashMarkers.lost(all).length;
      if (lostBeforeReplay > 0) {
        // queues.md "redis-queue lost data": replay the outbox for the crash window (consumers are idempotent).
        const until_ = new Date();
        for (;;) {
          const batch = await withSystem('chaos.replay', (tx) =>
            replayOutboxBatch(tx, { type: crashEvent.type, since: windowStart, until: until_ }),
          );
          replayed += batch.replayed;
          if (batch.replayed === 0) break;
        }
        await until(
          'every job ran after the replay',
          async () => (crashMarkers.lost(all).length === 0 ? true : undefined),
          120_000,
          200,
        );
      }
    } finally {
      await dispatcher.stop();
    }
    const drainedAt = Date.now();
    const queuedLost = crashMarkers.lost(queuedKeys).length;
    const lost = crashMarkers.lost(all).length;
    const dead = await deadEvents(crashEvent.type);
    r.check('the crash hit queued work', notYetRun > 0, `${notYetRun} queued jobs not yet run`);
    r.check('jobs on disk before the crash all survived (AOF)', queuedLost === 0, `${queuedLost} lost`);
    r.check('zero lost jobs (after the outbox replay)', lost === 0, `${lost} lost`);
    r.check('no outbox event dead-lettered', dead === 0, `${dead}`);
    r.rtoSeconds = secondsSince(t0, drainedAt);
    r.measure('crashToRedisReadySeconds', secondsSince(t0, restartedAt));
    r.measure('jobs', all.length);
    r.measure('jobsLostBeforeReplay', lostBeforeReplay);
    r.measure('eventsReplayed', replayed);
    r.measure('jobsLost', lost);
    r.measure('duplicateRuns', crashMarkers.duplicates());
    r.note(
      'Crash: enqueues acknowledged within the last second before the kill may be lost (appendfsync everysec); the outbox replay of the window recovers them (queues.md).',
    );
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Postgres primary lost: throwaway primary (WAL-G archiving to MinIO) + streaming standby, killed under load.
// ---------------------------------------------------------------------------------------------------------------

describe('chaos drill: Postgres primary', () => {
  const id = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const PRIMARY = `${THROWAWAY_PREFIX}pg-primary-${id}`;
  const STANDBY = `${THROWAWAY_PREFIX}pg-standby-${id}`;
  const STANDBY_VOLUME = `${THROWAWAY_PREFIX}pg-standby-${id}`;
  /** Local: segments switch every 10 s under load (production: 60 s, `postgres_archive_timeout`). */
  const ARCHIVE_TIMEOUT = 10;
  const REPL_PASSWORD = randomBytes(12).toString('hex');
  let dir = '';
  let walgEnv = '';
  let ticker: WriteTicker | undefined;
  let killedAt = 0;
  let ready = false;

  const psql = (container: string, q: string, host = '/var/run/postgresql') =>
    docker([
      'exec',
      '-u',
      'postgres',
      container,
      'psql',
      '-h',
      host,
      '-d',
      'inmolink',
      '-XtAq',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      q,
    ]);
  const up = (container: string) =>
    until(
      `${container} ready`,
      async () => ((await psql(container, 'select 1', '127.0.0.1')) === '1' ? true : undefined),
      120_000,
      500,
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'inmolink-chaos-'));
    walgEnv = join(dir, 'walg.env');
    writeFileSync(
      walgEnv,
      [
        `WALG_S3_PREFIX=s3://inmolink-backups/chaos-${id}`,
        'AWS_ACCESS_KEY_ID=inmolink',
        'AWS_SECRET_ACCESS_KEY=inmolink-local-secret',
        'AWS_ENDPOINT=http://minio-test:9000',
        'AWS_REGION=us-east-1',
        'AWS_S3_FORCE_PATH_STYLE=true',
        'WALG_COMPRESSION_METHOD=zstd',
        `WALG_LIBSODIUM_KEY=${randomBytes(32).toString('hex')}`,
        'WALG_LIBSODIUM_KEY_TRANSFORM=hex',
        'PGHOST=/var/run/postgresql',
        `POSTGRES_PASSWORD=${randomBytes(12).toString('hex')}`,
        'POSTGRES_DB=inmolink',
        '',
      ].join('\n'),
    );
    // db-1's archiving settings (postgresql.conf.j2), with a shorter archive_timeout.
    await docker([
      'run',
      '-d',
      '--name',
      PRIMARY,
      '--network',
      TEST_STACK_NETWORK,
      '--env-file',
      walgEnv,
      POSTGRES_IMAGE,
      'postgres',
      '-c',
      'wal_level=replica',
      '-c',
      'archive_mode=on',
      '-c',
      'archive_command=wal-g wal-push %p',
      '-c',
      `archive_timeout=${ARCHIVE_TIMEOUT}`,
      '-c',
      'max_wal_senders=5',
      '-c',
      'max_replication_slots=5',
      '-c',
      'max_connections=300',
    ]);
    await up(PRIMARY);
    await docker([
      'exec',
      PRIMARY,
      'bash',
      '-c',
      'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"',
    ]);
    await psql(
      PRIMARY,
      `create role replicator with login replication password '${REPL_PASSWORD}'; select pg_reload_conf()`,
    );
    await psql(PRIMARY, 'create table chaos_ticks (n int primary key, at timestamptz not null)');
    await docker(['exec', '-u', 'postgres', PRIMARY, 'inmolink-walg-backup']);
    await docker(['volume', 'create', STANDBY_VOLUME]);
    await docker([
      'run',
      '--rm',
      '-u',
      'postgres',
      '--network',
      TEST_STACK_NETWORK,
      '-v',
      `${STANDBY_VOLUME}:/var/lib/postgresql`,
      '-e',
      `PRIMARY_HOST=${PRIMARY}`,
      '-e',
      `REPLICATION_PASSWORD=${REPL_PASSWORD}`,
      '-e',
      'REPLICATION_SLOT=db_2',
      POSTGRES_IMAGE,
      'inmolink-replica-init',
    ]);
    await docker([
      'run',
      '-d',
      '--name',
      STANDBY,
      '--network',
      TEST_STACK_NETWORK,
      '-v',
      `${STANDBY_VOLUME}:/var/lib/postgresql`,
      POSTGRES_IMAGE,
      'postgres',
      '-c',
      'max_connections=300',
    ]);
    await up(STANDBY);
    await until('standby streaming', async () =>
      (await psql(PRIMARY, "select active from pg_replication_slots where slot_name = 'db_2'")) === 't'
        ? true
        : undefined,
    );

    // Write load, then the crash: SIGKILL, so nothing is flushed, switched or archived on the way down.
    const t = startWriteTicker(PRIMARY, 'chaos_ticks');
    ticker = t;
    await until(
      'a first archived segment under load',
      async () =>
        t.acked.size > 50 && Number(await psql(PRIMARY, 'select archived_count from pg_stat_archiver')) >= 2
          ? true
          : undefined,
      120_000,
      500,
    );
    await new Promise((res) => setTimeout(res, 3_000)); // writes past the last archived segment: the PITR loss window
    killedAt = Date.now();
    await killContainer(PRIMARY);
    await t.exited;
    ready = true;
  }, 300_000);

  afterAll(async () => {
    ticker?.stop();
    if (walgEnv) {
      await docker([
        'run',
        '--rm',
        '--network',
        TEST_STACK_NETWORK,
        '--env-file',
        walgEnv,
        POSTGRES_IMAGE,
        'wal-g',
        'delete',
        'everything',
        'FORCE',
        '--confirm',
      ]).catch(() => undefined);
    }
    await docker(['rm', '-f', '-v', PRIMARY, STANDBY]).catch(() => undefined);
    await docker(['volume', 'rm', '-f', STANDBY_VOLUME]).catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it('[S16-02] kill Postgres primary: the standby is promoted with the runbook command and takes writes within the RTO; acknowledged writes lost (RPO) measured', async () => {
    expect(ready).toBe(true);
    const t = ticker as WriteTicker;
    const r = new DrillRecorder('postgres-primary', 'local');
    const promoted = r.disrupt(PRIMARY, 'docker kill (throwaway primary; never restarted)', killedAt);
    // runbook failover.md step 2 (fencing is the kill itself here)
    await docker(['exec', '-u', 'postgres', STANDBY, 'bash', '-c', 'pg_ctl promote -D "$PGDATA"']);
    await until(
      'standby promoted',
      async () => ((await psql(STANDBY, 'select pg_is_in_recovery()')) === 'f' ? true : undefined),
      120_000,
      200,
    );
    const marker = t.last() + 1_000;
    await psql(STANDBY, `insert into chaos_ticks values (${marker}, clock_timestamp())`);
    const writableAt = Date.now();
    promoted(writableAt);
    const [maxN, maxAt, count] = (
      await psql(STANDBY, `select max(n), extract(epoch from max(at)), count(*) from chaos_ticks where n < ${marker}`)
    ).split('|');
    const loss = writesLost(t, Number(maxN), Number(maxAt));
    r.check('promoted standby accepts writes', true);
    // A row in flight at the kill may have committed without its ack reaching the client: at most one beyond.
    r.check(
      'the standby holds a gap-free prefix of the writes',
      Number(count) === Number(maxN) && Number(maxN) <= t.last() + 1,
      `max ${maxN}, count ${count}, last acked ${t.last()}`,
    );
    r.rtoSeconds = secondsSince(killedAt, writableAt);
    r.rpoSeconds = loss.rpoSeconds;
    r.measure('ackedWrites', t.acked.size);
    r.measure('ackedWritesLost', loss.lost);
    r.measure('walFileAfterPromotion', await psql(STANDBY, 'select pg_walfile_name(pg_current_wal_lsn())'));
    r.note(
      'rtoSeconds = primary killed → promoted standby committed a write. Production adds detection, fencing db-1, repointing DATABASE_URL_* and a redeploy (failover.md steps 1, 3, 4): staging H4.',
    );
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
  }, 180_000);

  it('[S16-02] full restore from PITR to a fresh server: the WAL-G store restores onto a fresh container; RTO and RPO (acknowledged commits not replayed) measured', async () => {
    expect(ready).toBe(true);
    const t = ticker as WriteTicker;
    const r = new DrillRecorder('pitr', 'local');
    r.disrupt(PRIMARY, 'primary lost (the kill above); restored from the WAL-G store', killedAt)(killedAt);
    const report = await restoreDrill({
      image: POSTGRES_IMAGE,
      walgEnvFile: walgEnv,
      network: TEST_STACK_NETWORK,
      verifySql: "select max(n) || '|' || extract(epoch from max(at)) || '|' || count(*) from chaos_ticks",
      replayTimeoutMs: 180_000,
    });
    const [maxN, maxAt, count] = (report.verifyOutput ?? '').split('|');
    const loss = writesLost(t, Number(maxN), Number(maxAt));
    r.check('restored, promoted, writable, not archiving', report.archiveMode === 'off');
    r.check('restored rows are a prefix of the acknowledged writes', Number(count) === Number(maxN));
    r.rtoSeconds = report.rtoSeconds;
    r.rpoSeconds = loss.rpoSeconds;
    r.measure('ackedWritesLost', loss.lost);
    r.measure('fetchBaseSeconds', report.phasesSeconds.fetchBase);
    r.measure('replayAndPromoteSeconds', report.phasesSeconds.replayAndPromote);
    r.measure('archiveTimeoutSeconds', ARCHIVE_TIMEOUT);
    r.note(
      `RPO is bounded by archive_timeout (${ARCHIVE_TIMEOUT} s here, 60 s in production) plus the push time; RTO here is a few-MB base backup from a local MinIO.`,
    );
    const result = record(r);
    expect(failedChecks(result)).toEqual([]);
    expect(await docker(['ps', '-a', '--filter', 'name=inmolink-restore-', '--format', '{{.Names}}'])).toBe('');
  }, 300_000);
});
