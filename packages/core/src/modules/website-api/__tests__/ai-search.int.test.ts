import { fileURLToPath } from 'node:url';
import { CreateListingBody, UpdateListingBody, WebsiteAiSearchPage, WebsiteAiSearchQuery } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureAi, createAiGateway, filePromptSource, usageMonth } from '@inmolink/platform/ai';
import { FakeProvider, memoryAiStore } from '@inmolink/platform/ai/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, purgeReferenceFixtures } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import type { SearchAiAnswer } from '../ai-search-parse';
import * as websiteApi from '../index';

/**
 * AI search (S12-08): a sentence → filters (a fake parser stands in for the model: tests never call the provider) →
 * the site's search; cached by the normalized sentence; any AI failure or a slow model answers with a keyword search.
 */

const RUN = newId().slice(-8).toLowerCase();
const PREFIX = `aisx-${RUN.replace(/[^a-z0-9]/g, '')}-`;
const code = (s: string) => `${PREFIX}${s}`;
const UID = `t_aisx_${RUN.replace(/[^A-Za-z0-9]/g, '')}`;
const real = () =>
  createMeiliEngine({ url: process.env.MEILI_URL as string, apiKey: process.env.MEILI_MASTER_KEY as string });

let a: Founder;
let siteId: string;
let ids: { gamma: string; delta: string; villa: string; flat: string };
const L: Record<string, string> = {};
/** Gamma's name in this run (place names the fake model answers with). */
/** The run id in letters only (a place name is letters, blanks and - ' .). */
const TAG = RUN.replace(/[^a-z]/g, (c) => 'abcdefghijklmnopqrstuvwxyz'[c.charCodeAt(0) % 26] as string);
const GAMMA = `Gamma ${TAG}`;

const as = <T>(fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.ai-search.test', fn);
const site = () => websiteApi.siteForKey({ agencyId: a.agencyId, siteId }, newId());
const query = (q: string, extra: Record<string, unknown> = {}) => WebsiteAiSearchQuery.parse({ q, ...extra });

const CALLER: websiteApi.AiSearchCaller = { keyId: newId(), kind: 'SECRET', ip: '203.0.113.0' };
/** A limiter that allows every miss and keeps the checks it was asked (or denies the rules named). */
function limiter(deny: string[] = []) {
  const seen: RateLimitCheck[] = [];
  return {
    seen,
    limiter: {
      consumeMany: async (checks: readonly RateLimitCheck[]) =>
        checks.map((c) => {
          seen.push(c);
          const allowed = !deny.includes(c.rule.name);
          return {
            allowed,
            limit: c.rule.limit,
            remaining: allowed ? 1 : 0,
            retryAfterSeconds: allowed ? 0 : 60,
            resetAtMs: 0,
          };
        }),
    } as unknown as RateLimiter,
  };
}
const ask = (
  s: websiteApi.ApiSite,
  q: ReturnType<typeof query>,
  opts: Parameters<typeof websiteApi.aiSearch>[2] = {},
) => websiteApi.aiSearch(s, q, { caller: CALLER, ...opts });
const configure = (p: Partial<websiteApi.AiSearchSettings>) => {
  const l = limiter();
  websiteApi.configureAiSearch({ limiter: () => l.limiter, cacheReady: () => true, ...p });
};

const EMPTY: SearchAiAnswer = {
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

/** A scripted model: counts calls, answers by sentence. */
function fakeParser(answer: (q: string) => Partial<SearchAiAnswer> | Error, delayMs = 0) {
  const calls: string[] = [];
  const ctxs: unknown[] = [];
  return {
    calls,
    ctxs,
    parser: {
      async parse(ctx: unknown, q: string) {
        calls.push(q);
        ctxs.push(ctx);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const out = answer(q);
        if (out instanceof Error) throw out;
        return { ...EMPTY, ...out };
      },
    },
  };
}

async function listing(body: Partial<CreateListingBody>): Promise<string> {
  const { id } = await as((ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.gamma,
        priceCents: 30_000_000,
        energyRating: 'B',
        ...body,
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
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureCache({ prefix: `t:aisx:${RUN}` });
  search.configureWebsiteSearch({ engineTimeoutMs: 5_000, slowMs: 4_000 });
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  a = await createFounder();
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: tr(`Aisland ${RUN}`, 'c'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: tr(`Shore ${RUN}`, 'r'),
    });
    const city = (n: string) =>
      taxonomy.createLocation(tx, {
        level: 'CITY',
        parentId: region,
        code: code(n.toLowerCase()),
        translations: tr(`${n} ${TAG}`, n.toLowerCase()),
      });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('g'),
      sort: 0,
      translations: tr('Homes', 'g'),
    });
    // Named as a catalog names them ("Villa", "Apartment"): the concepts resolve by name.
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: tr('Villa', 'villa'),
    });
    const flat = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('flat'),
      sort: 1,
      translations: tr('Apartment', 'flat'),
    });
    return { gamma: await city('Gamma'), delta: await city('Delta'), villa, flat };
  });
  await taxonomy.invalidateTaxonomyCache();
  L.villa = await listing({ bedrooms: 3 });
  L.flat = await listing({ propertyTypeId: ids.flat, bedrooms: 3 });
  L.small = await listing({ bedrooms: 2 });
  L.delta = await listing({ locationId: ids.delta, bedrooms: 4 });
  siteId = (
    await as((ctx) =>
      websites.createSite(ctx, {
        name: 'AI Homes',
        domains: ['www.ai-homes.example'],
        mode: 'WP_PLUGIN',
        inventoryPolicy: 'OWN_ONLY',
        inventoryFilters: null,
        referencePrefix: 'AI',
        locales: ['en', 'es'],
        contact: null,
      }),
    )
  ).id;
  configureSearch(real());
  search.configureSearchIndex({ uid: UID, scope: Object.values(L) });
  await search.ensureListingsIndex(real(), search.listingsIndex(UID));
  await search.syncIndex();
  search.resetSearchBreaker();
}, 180_000);

afterEach(() => {
  websiteApi.configureAiSearch(undefined);
  configureAi(undefined);
});

afterAll(async () => {
  await real()
    .dropIndex(UID)
    .catch(() => undefined);
  const all = sql.join(
    Object.values(L).map((t) => sql`${t}`),
    sql`, `,
  );
  if (Object.keys(L).length > 0) {
    await system(async (tx) => {
      await tx.execute(sql`delete from search_index_queue where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_docs where target_id in (${all})`);
      await tx.execute(sql`delete from listing_search_commissions where target_id in (${all})`);
    });
  }
  await purgeReferenceFixtures(PREFIX).catch(() => undefined);
  await closeCache();
  await closeDb();
});

const idsOf = (page: WebsiteAiSearchPage) => page.items.map((i) => i.id).sort();

describe('AI search for websites (S12-08)', () => {
  it("[S12-08] a sentence is understood as filters and searched in the site's inventory, within 3 queries", async () => {
    const fake = fakeParser(() => ({ types: ['villa'], places: [GAMMA], bedsMin: 3 }));
    configure({ parser: fake.parser });
    const s = await site();
    // Warm the site's and the taxonomy's caches (a first request of the process reads them once).
    await ask(s, query(`warm up ${RUN}`));
    const sentence = `3 bed villa in gamma ${RUN}`;
    let page = undefined as unknown as WebsiteAiSearchPage;
    const queries = await countQueries(async () => {
      page = await ask(s, query(sentence));
    });
    WebsiteAiSearchPage.parse(page);
    // The shared test database may hold other suites' "Villa" types too (types are ORed: harmless).
    expect(page.understood).toMatchObject({
      source: 'AI',
      filters: { types: expect.arrayContaining([ids.villa]), locations: [ids.gamma], bedsMin: 3 },
      unmatched: [],
    });
    expect(page.understood.filters.types).not.toContain(ids.flat);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.ref).toBeTruthy();
    expect(page.total).toBe(1);
    expect(queries).toBeLessThanOrEqual(3);
    expect(fake.calls).toContain(sentence);
  });

  it('[S12-08] cached by the normalized sentence: the same words in another case or spacing ask the model once', async () => {
    const fake = fakeParser(() => ({ types: ['villa'], places: [GAMMA] }));
    configure({ parser: fake.parser });
    const s = await site();
    const first = await ask(s, query(`Villas in Gamma ${RUN}!`));
    const second = await ask(s, query(`  villas   IN gamma ${RUN} `));
    expect(fake.calls).toEqual([`villas in gamma ${RUN}`]);
    expect(second.understood).toEqual(first.understood);
    expect(idsOf(second)).toEqual(idsOf(first));
    expect(first.items.length).toBeGreaterThanOrEqual(2);
  });

  it('[S12-08] any AI failure (budget, outage, invalid output, refusal) falls back to a keyword search', async () => {
    const s = await site();
    for (const [i, code] of (
      ['AI_BUDGET_EXCEEDED', 'AI_UNAVAILABLE', 'AI_OUTPUT_INVALID', 'AI_REFUSED'] as const
    ).entries()) {
      const fake = fakeParser(() => new AppError(code));
      configure({ parser: fake.parser });
      const page = await ask(s, query(`sunny villa ${i} ${RUN}`));
      expect(page.understood, code).toEqual({
        source: 'KEYWORD',
        filters: { q: `sunny villa ${i} ${RUN}` },
        unmatched: [],
      });
      WebsiteAiSearchPage.parse(page);
      expect(fake.calls).toHaveLength(1);
    }
    // An unexpected error too, and a failure is not cached: the next request asks again.
    const broken = fakeParser(() => new Error('boom'));
    configure({ parser: broken.parser });
    await ask(s, query(`broken ${RUN}`));
    await ask(s, query(`broken ${RUN}`));
    expect(broken.calls).toHaveLength(2);
  });

  it('[S12-08] with no AI gateway installed the default parser degrades to keyword search', async () => {
    configureAi(undefined);
    const page = await ask(await site(), query(`villa gamma ${RUN} nogateway`));
    expect(page.understood.source).toBe('KEYWORD');
  });

  it('[S12-08] through the AI gateway: the FAST prompt with a JSON schema, metered to the site agency; hard cap → keyword', async () => {
    const answer = JSON.stringify({ ...EMPTY, types: ['villa'], places: [GAMMA] });
    const provider = new FakeProvider(() => answer);
    const month = usageMonth(new Date());
    const gateway = (spend: number) => {
      const store = memoryAiStore({ [`${a.agencyId}:${month}`]: spend });
      configureAi(
        createAiGateway({
          provider,
          models: { FAST: 'fast-model', SMART: 'smart-model' },
          pricing: { 'fast-model': { input: 1, output: 5 }, 'smart-model': { input: 4, output: 20 } },
          batchDiscountBp: 5_000,
          prompts: filePromptSource(fileURLToPath(new URL('../../../../prompts', import.meta.url))),
          cache: null,
          cacheTtlSeconds: 0,
          store,
          budgetFor: () => ({ softMicroUsd: 50_000, hardMicroUsd: 100_000 }),
          timeoutMs: 5_000,
          breaker: { failures: 3, openMs: 30_000 },
          logger: createLogger({ service: 'test', level: 'silent' }),
        }),
      );
      return store;
    };
    const s = await site();
    const store = gateway(0);
    const page = await ask(s, query(`gateway villa gamma ${RUN}`));
    expect(page.understood.source).toBe('AI');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.user).toBe(websiteApi.aiSearchInput(`gateway villa gamma ${RUN}`));
    expect(provider.calls[0]?.jsonSchema).toBeDefined();
    expect(store.jobs).toMatchObject([
      { agencyId: a.agencyId, feature: websiteApi.AI_SEARCH_FEATURE, tier: 'FAST', status: 'SUCCEEDED' },
    ]);
    // At the hard cap the provider is not called; the visitor still gets results.
    gateway(100_000);
    const capped = await ask(s, query(`capped villa gamma ${RUN}`));
    expect(capped.understood.source).toBe('KEYWORD');
    expect(provider.calls).toHaveLength(1);
  });

  it('[S12-08] only cache misses reach the model, counted per key, site and agency month; a denied miss searches words', async () => {
    const s = await site();
    const fake = fakeParser(() => ({ types: ['villa'], places: [GAMMA] }));
    const counted = limiter();
    configure({ parser: fake.parser, limiter: () => counted.limiter });
    expect((await ask(s, query(`counted villa gamma ${RUN}`))).understood.source).toBe('AI');
    expect((await ask(s, query(`counted villa gamma ${RUN}`))).understood.source).toBe('AI'); // a hit: not counted
    expect(counted.seen.map((c) => [c.rule.name, c.identity])).toEqual([
      ['ai-search.key', CALLER.keyId],
      ['ai-search.site', siteId],
      ['ai-search.month', a.agencyId],
    ]);
    expect(counted.seen.every((c) => c.rule.failClosed === true)).toBe(true);
    // A browser (publishable key) is counted on its own too.
    await ask(s, query(`browser villa gamma ${RUN}`), { caller: { ...CALLER, kind: 'PUBLISHABLE' } });
    expect(counted.seen.at(-1)).toMatchObject({
      rule: { name: 'ai-search.browser' },
      identity: `${CALLER.keyId}|203.0.113.0`,
    });
    // The tenant ctx names the site agency and its plan.
    expect(fake.ctxs[0]).toMatchObject({ tenant: { agencyId: a.agencyId, plan: 'none' } });
    for (const rule of ['ai-search.key', 'ai-search.site', 'ai-search.month']) {
      const denied = limiter([rule]);
      configure({ parser: fake.parser, limiter: () => denied.limiter });
      const page = await ask(s, query(`denied ${rule} gamma ${RUN}`));
      expect(page.understood.source, rule).toBe('KEYWORD');
    }
    // The limiter unreachable: fail closed.
    configure({
      parser: fake.parser,
      limiter: () => ({ consumeMany: async () => Promise.reject(new Error('down')) }) as unknown as RateLimiter,
    });
    expect((await ask(s, query(`limiter down gamma ${RUN}`))).understood.source).toBe('KEYWORD');
    expect(fake.calls).toHaveLength(2);
  });

  it('[S12-08] suspicious callers, cursor pages and key-less calls read the cache only; redis-cache down never calls the model', async () => {
    const s = await site();
    const fake = fakeParser(() => ({ types: ['villa'], places: [GAMMA] }));
    configure({ parser: fake.parser });
    expect((await ask(s, query(`suspicious villa gamma ${RUN}`), { suspicious: true })).understood.source).toBe(
      'KEYWORD',
    );
    const firstPage = await ask(s, query(`paged villa gamma ${RUN}`, { limit: 1 }));
    expect(fake.calls).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    // The next page of an understood sentence: the cached answer, no model call.
    const next = await ask(s, query(`paged villa gamma ${RUN}`, { limit: 1, cursor: firstPage.nextCursor }));
    expect(next.understood.source).toBe('AI');
    // A cursor page of a sentence never understood: words, no model call.
    expect(
      (await ask(s, query(`never seen villa ${RUN}`, { limit: 1, cursor: firstPage.nextCursor }))).understood.source,
    ).toBe('KEYWORD');
    expect((await websiteApi.aiSearch(s, query(`no caller villa ${RUN}`))).understood.source).toBe('KEYWORD');
    // A suspicious caller still gets a cached answer.
    expect((await ask(s, query(`paged villa gamma ${RUN}`), { suspicious: true })).understood.source).toBe('AI');
    configure({ parser: fake.parser, cacheReady: () => false });
    expect((await ask(s, query(`cache down villa gamma ${RUN}`))).understood.source).toBe('KEYWORD');
    expect(fake.calls).toHaveLength(1);
  });

  it('[S12-08] at most maxLateCalls model calls outlive their request; beyond it no new one starts', async () => {
    const s = await site();
    const fake = fakeParser(() => ({ types: ['villa'], places: [GAMMA] }), 400);
    configure({ parser: fake.parser, timeoutMs: 30, maxLateCalls: 1 });
    expect((await ask(s, query(`late one gamma ${RUN}`))).understood.source).toBe('KEYWORD');
    expect(websiteApi.aiSearchLateCalls()).toBe(1);
    expect((await ask(s, query(`late two gamma ${RUN}`))).understood.source).toBe('KEYWORD');
    expect(fake.calls).toHaveLength(1);
    for (let i = 0; i < 40 && websiteApi.aiSearchLateCalls() > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(websiteApi.aiSearchLateCalls()).toBe(0);
    // The late answer landed: the first sentence is understood now.
    expect((await ask(s, query(`late one gamma ${RUN}`))).understood.source).toBe('AI');
  });

  it('[S12-08] a slow model times out into a keyword search; its late answer fills the cache', async () => {
    const fake = fakeParser(() => ({ types: ['villa'], places: [GAMMA] }), 300);
    configure({ parser: fake.parser, timeoutMs: 50 });
    const s = await site();
    const started = Date.now();
    const slow = await ask(s, query(`slow villa gamma ${RUN}`));
    expect(slow.understood.source).toBe('KEYWORD');
    expect(Date.now() - started).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 400));
    const later = await ask(s, query(`slow villa gamma ${RUN}`));
    expect(later.understood.source).toBe('AI');
    expect(fake.calls).toHaveLength(1);
  });

  it('[S12-08] nothing understood (no filter) searches the words; unknown places search as text', async () => {
    const fake = fakeParser((q) => (q.includes('weather') ? {} : { places: [`Nowhere ${TAG}`], bedsMin: 2 }));
    configure({ parser: fake.parser });
    const s = await site();
    expect((await ask(s, query(`weather ${RUN}`))).understood.source).toBe('KEYWORD');
    const unknown = await ask(s, query(`2 bed in nowhere ${RUN}`));
    expect(unknown.understood).toEqual({
      source: 'AI',
      filters: { q: `Nowhere ${TAG}`, bedsMin: 2 },
      unmatched: [`Nowhere ${TAG}`],
    });
    // The understood sentence is in the shared cache under the global key.
    const key = websiteApi.aiSearchCacheKey(`2 bed in nowhere ${RUN}`);
    expect(await cache.get(key, { ttlSeconds: 60 }, async () => 'miss')).not.toBe('miss');
  });
});
