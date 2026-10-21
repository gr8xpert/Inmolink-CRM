import { CreateListingBody, UpdateListingBody, type WebsiteListingPage } from '@inmolink/contracts';
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
import { createFakeClock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, configureRateLimit, RateLimiter, rateLimitConnection } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Website API quotas and anti-scraping over HTTP (S7-04), with the real limiter on the limits Redis: daily quota with
 * its reset time, scripted paging throttled and alerted, per-browser limits for publishable keys, honeytokens on deep
 * pages of suspected scrapers only.
 */

const RUN = newId().slice(-8);
const CURSOR_KEY = 'test-cursor-key-0123456789abcdef0123';
const LISTINGS = 6;
// Mid-day, so no test straddles midnight by accident.
const clock = createFakeClock(Date.UTC(2026, 9, 21, 12, 0, 30));
const prefix = `t:rl:scrape:${RUN}`;
const alerts: websiteApi.WebsiteAlert[] = [];

let app: Awaited<ReturnType<typeof buildApp>>;
let founder: Founder;
let siteId: string;

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Limits for one test: small, so a few requests reach them. */
function limits(next: Partial<websiteApi.WebsiteLimits>) {
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: CURSOR_KEY,
    limits: next,
    onAlert: (a) => alerts.push(a),
  });
}

async function newKey(kind: 'SECRET' | 'PUBLISHABLE'): Promise<string> {
  const issued = await as((ctx) =>
    identity.createApiKey(ctx, {
      name: `${kind} ${newId().slice(-4)}`,
      kind,
      scopes: ['listings:read'],
      allowedOrigins: kind === 'PUBLISHABLE' ? ['https://www.scrape-site.example'] : [],
      siteId,
    }),
  );
  return issued.secret;
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:feed-scrape:${RUN}` });
  await configureRateLimit({ commandTimeoutMs: 5_000 });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  limits({});
  // The engine is unreachable here: website search answers from the Postgres fallback.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  const ids = await withSystem('feed-api.scrape.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `sc-${RUN}`,
      translations: name('Scrapeland'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: country,
        code: `sc-r-${RUN}`,
        translations: name('Coast'),
      }),
      code: `sc-c-${RUN}`,
      translations: name('Harbour'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `sc-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `sc-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const listingIds: string[] = [];
  for (let i = 0; i < LISTINGS; i++) {
    const { id } = await as((ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 30_000_000 + i * 1_000_000,
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
    listingIds.push(id);
  }
  await withSystem('feed-api.scrape.test', (tx) => search.rebuildReadModels(tx, 'LISTING', listingIds));
  const site = await as((ctx) =>
    websites.createSite(ctx, {
      name: 'Scrape site',
      domains: ['www.scrape-site.example'],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_ONLY',
      inventoryFilters: null,
      referencePrefix: 'SS',
      locales: ['en'],
      contact: null,
    }),
  );
  siteId = site.id;
  const redis = rateLimitConnection();
  const limiter = new RateLimiter({
    redis,
    prefix,
    logger: createLogger({ level: 'silent' }),
    clock,
    hmacKey: 'test-rate-limit-hmac-key-0123456789abcdef',
  });
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter,
    checks: {},
  });
}, 240_000);

afterAll(async () => {
  await app?.close();
  try {
    const redis = rateLimitConnection();
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Not connected (setup failed): nothing to clean.
  }
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

beforeEach(() => {
  alerts.length = 0;
  limits({});
});

const get = (url: string, key: string, opts: { ip?: string; origin?: string } = {}) =>
  app.inject({
    method: 'GET',
    url,
    remoteAddress: opts.ip ?? '198.51.100.10',
    headers: { 'x-api-key': key, ...(opts.origin ? { origin: opts.origin } : {}) },
  });

/** Pages `/v2/listings?limit=1` from the first page; the answers in order (stops at the first non-200). */
async function pageThrough(key: string, opts: { ip?: string; origin?: string; pages?: number } = {}) {
  const pages: {
    status: number;
    body: WebsiteListingPage | { error: { code: string } };
    headers: Record<string, unknown>;
  }[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < (opts.pages ?? LISTINGS); i++) {
    const res = await get(`/v2/listings?limit=1${cursor ? `&cursor=${cursor}` : ''}`, key, opts);
    pages.push({ status: res.statusCode, body: res.json(), headers: res.headers });
    if (res.statusCode !== 200) break;
    cursor = (res.json() as WebsiteListingPage).nextCursor;
    if (!cursor) break;
  }
  return pages;
}

const isToken = (ref: string) => websiteApi.isHoneytokenRef(CURSOR_KEY, { siteId, referencePrefix: 'SS' }, ref);

describe('website API quotas and anti-scraping (S7-04)', () => {
  it('[S7-04] exceeding the daily quota returns 429 with the reset time', async () => {
    limits({ dailyQuota: { STANDARD: 3, HIGH: 3 }, burst: { STANDARD: 2, HIGH: 2 } });
    const key = await newKey('SECRET');
    // Requests refused by another rule (a burst) never burn the quota.
    for (let i = 0; i < 2; i++) expect((await get('/v2/listings?limit=1', key)).statusCode).toBe(200);
    expect((await get('/v2/listings?limit=1', key)).json().error.code).toBe('RATE_LIMITED');
    clock.advance(10_000);
    expect((await get('/v2/listings?limit=1', key)).statusCode).toBe(200);
    const res = await get('/v2/listings?limit=1', key);
    expect(res.statusCode).toBe(429);
    const midnight = Date.UTC(2026, 9, 22);
    const retryAfter = Math.ceil((midnight - clock.nowMs()) / 1_000);
    expect(res.headers['retry-after']).toBe(String(retryAfter));
    expect(res.json()).toEqual({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'Quota exceeded',
        details: {
          scope: 'key',
          quota: 'daily',
          limit: 3,
          resetAt: new Date(midnight).toISOString(),
          retryAfterSeconds: retryAfter,
        },
      },
    });
    // Every endpoint counts; another key of the agency has its own quota.
    clock.advance(10_000);
    expect((await get('/v2/sitemap', key)).statusCode).toBe(429);
    expect((await get('/v2/listings?limit=1', await newKey('SECRET'))).statusCode).toBe(200);
  });

  it('[S7-04] publishable keys: a few clients cannot use up the site’s daily quota — each browser has its own share', async () => {
    limits({ dailyQuota: { STANDARD: 3, HIGH: 3 }, browserPerDay: 2 });
    const key = await newKey('PUBLISHABLE');
    const origin = 'https://www.scrape-site.example';
    for (const ip of ['203.0.113.60', '203.0.113.61', '203.0.113.62']) {
      for (let i = 0; i < 2; i++) expect((await get('/v2/sitemap', key, { ip, origin })).statusCode).toBe(200);
    }
    // Past the key's own daily quota (3): an alert, nobody refused for it.
    expect(alerts).toEqual([expect.objectContaining({ action: 'observed', rule: 'feed.quota.standard' })]);
    const share = await get('/v2/sitemap', key, { ip: '203.0.113.60', origin });
    expect(share.statusCode).toBe(429);
    expect(share.json().error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { scope: 'ip', limit: 2 } });
    expect((await get('/v2/sitemap', key, { ip: '203.0.113.63', origin })).statusCode).toBe(200);
  });

  it('[S7-04] scripted full-inventory paging triggers an alert and throttling (secret key)', async () => {
    // Deep from page 2; two deep pages an hour.
    limits({ deepPage: 2, deepPerHour: 2, pagingPenaltySeconds: 3_600 });
    const key = await newKey('SECRET');
    const pages = await pageThrough(key);
    // Pages 0–3 served (2 and 3 are the deep ones), page 4 throttled.
    expect(pages.map((p) => p.status)).toEqual([200, 200, 200, 200, 429]);
    expect(pages.at(-1)?.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(alerts).toEqual([
      expect.objectContaining({ kind: 'scraping', action: 'flagged', scope: 'key', siteId, keyKind: 'SECRET' }),
      expect.objectContaining({ kind: 'scraping', action: 'throttled', scope: 'key', siteId, keyKind: 'SECRET' }),
    ]);
    // Throttled for the penalty, even once the hour's window has slid on; no new alert.
    clock.advance(30 * 60_000);
    expect((await pageThrough(key, { pages: 4 })).map((p) => p.status)).toEqual([200, 200, 429]);
    expect(alerts).toHaveLength(2);
    // Shallow pages (what visitors see) are still served.
    expect((await get('/v2/listings?limit=1', key)).statusCode).toBe(200);
    // Once the penalty is over and the hour has slid out, it pages again.
    clock.advance(91 * 60_000);
    expect((await pageThrough(key, { pages: 4 })).map((p) => p.status)).toEqual([200, 200, 200, 200]);
  });

  it('[S7-04] publishable keys: one browser that pages like a script is throttled, the site’s other visitors are not', async () => {
    limits({ browserPagingLimit: 2, pagingPenaltySeconds: 3_600 });
    const key = await newKey('PUBLISHABLE');
    const origin = 'https://www.scrape-site.example';
    const scraper = await pageThrough(key, { ip: '203.0.113.50', origin });
    expect(scraper.map((p) => p.status)).toEqual([200, 200, 200, 429]);
    expect(alerts).toEqual([
      expect.objectContaining({ action: 'throttled', scope: 'browser', keyKind: 'PUBLISHABLE' }),
    ]);
    // The same key from another visitor pages on (a forged Origin does not make a script one of them).
    expect((await pageThrough(key, { ip: '203.0.113.51', origin, pages: 3 })).map((p) => p.status)).toEqual([
      200, 200, 200,
    ]);
    // And one browser's per-minute share is its own.
    limits({ browserPerMinute: 2 });
    const busy = '203.0.113.52';
    await get('/v2/sitemap', key, { ip: busy, origin });
    await get('/v2/sitemap', key, { ip: busy, origin });
    const denied = await get('/v2/sitemap', key, { ip: busy, origin });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.details.scope).toBe('ip');
    expect(denied.headers['access-control-allow-origin']).toBe(origin);
  });

  it('[S7-04] a busy secret key with many shallow pagers is not suspicious and gets no honeytokens', async () => {
    limits({ deepPage: 3, honeytokenMinPage: 1 });
    const key = await newKey('SECRET');
    // 25 visitors of a server-rendered site, each paging to page 2: 50 paged requests, none deep.
    const served = [];
    for (let v = 0; v < 25; v++) served.push(...(await pageThrough(key, { pages: 3 })));
    expect(served.every((p) => p.status === 200)).toBe(true);
    expect(served.flatMap((p) => (p.body as WebsiteListingPage).items).some((c) => isToken(c.ref))).toBe(false);
    expect(served.every((p) => p.headers.etag !== undefined)).toBe(true);
    expect(alerts).toEqual([]);
  });

  it('[S7-04] honeytokens: on deep pages of a suspected scraper only, in place of a card; their detail answers 404 and alerts', async () => {
    limits({ deepPage: 2, honeytokenMinPage: 2 });
    const scraper = await newKey('SECRET');
    const pages = await pageThrough(scraper);
    expect(pages.every((p) => p.status === 200)).toBe(true);
    const bodies = pages.map((p) => p.body as WebsiteListingPage);
    const tokens = bodies.flatMap((b, depth) => b.items.filter((c) => isToken(c.ref)).map((c) => ({ depth, c })));
    // Not on pages 0 and 1; on every deeper page, in place of the page's card: the page keeps its size.
    expect(tokens.map((t) => t.depth)).toEqual([2, 3, 4, 5]);
    for (const [depth, body] of bodies.entries()) {
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(LISTINGS);
      // Answers to a suspected scraper are never stored or revalidated anywhere.
      expect(pages[depth]?.headers['cache-control']).toBe(
        depth >= 2 ? 'private, no-store' : 'private, max-age=0, must-revalidate',
      );
      expect(pages[depth]?.headers.etag === undefined).toBe(depth >= 2);
    }
    // The same pages for a caller that does not page deep enough: no honeytoken anywhere.
    limits({ deepPage: 1_000, honeytokenMinPage: 2 });
    const visitor = await pageThrough(await newKey('SECRET'));
    expect(visitor.flatMap((p) => (p.body as WebsiteListingPage).items).some((c) => isToken(c.ref))).toBe(false);
    // Never in the sitemap or the change feed (they feed the site's public pages and caches).
    const sitemap = (await get('/v2/sitemap?limit=100', scraper)).json() as { items: { ref: string }[] };
    expect(sitemap.items).toHaveLength(LISTINGS);
    expect(sitemap.items.some((i) => isToken(i.ref))).toBe(false);
    const feed = (
      await get(`/v2/changes?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`, scraper)
    ).json() as {
      items: { ref: string }[];
    };
    expect(feed.items.length).toBeGreaterThanOrEqual(LISTINGS);
    expect(feed.items.some((i) => isToken(i.ref))).toBe(false);
    // Its detail: the 404 of a withdrawn listing, and the alert names the site and the key.
    alerts.length = 0;
    const token = tokens[0]?.c.ref as string;
    const hit = await get(`/v2/listings/${token}`, scraper);
    expect(hit.statusCode).toBe(404);
    expect(hit.json().error.code).toBe('LISTING_NOT_FOUND');
    expect(alerts).toEqual([expect.objectContaining({ kind: 'honeytoken', ref: token, siteId })]);
    // An unknown reference that is no honeytoken is a plain 404.
    alerts.length = 0;
    expect((await get('/v2/listings/SS-00000000', scraper)).statusCode).toBe(404);
    expect(alerts).toEqual([]);
  });

  it('[S7-04] search cursors carry a signed depth: a tampered or another site’s cursor is refused', async () => {
    const key = await newKey('SECRET');
    const first = (await get('/v2/listings?limit=1', key)).json() as WebsiteListingPage;
    const cursor = first.nextCursor as string;
    expect((await get(`/v2/listings?limit=1&cursor=${cursor}`, key)).statusCode).toBe(200);
    // Depth reset to 0 with the rest kept: the MAC no longer matches.
    const reset = `000${cursor.slice(3)}`;
    const res = await get(`/v2/listings?limit=1&cursor=${reset}`, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({ field: 'cursor' });
  });
});
