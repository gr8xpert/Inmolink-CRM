import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreateListingBody, type CreateSiteInput, UpdateListingBody } from '@inmolink/contracts';
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
import { edgeKeyToken } from './plugins/api-key';
import { WEBSITE_API_TTL } from './routes/website-api/routes';

/**
 * Edge caching of the website API over HTTP (S7-06, ADR 0012 #5) with `WEBSITE_EDGE_CACHE` on. The origin's headers
 * are checked directly, and through a model of Cloudflare's cache as `infra/cloudflare/cache-rules.json` configures it
 * (eligible GETs under /v2/, cached only when the origin says `public` + `s-maxage`, key = path + sorted query + the
 * values of the `Vary` headers the rule passes through, any other `Vary` header bypasses, `stale-if-error` honoured).
 * What the model cannot show — Cloudflare itself serving stale with the origin stopped — is the staging check
 * (BLOCKED-HUMAN, runbook cdn.md).
 */

const RUN = newId().slice(-8);
const ROOT = join(import.meta.dirname, '..', '..', '..');
const RULE = (
  JSON.parse(readFileSync(join(ROOT, 'infra', 'cloudflare', 'cache-rules.json'), 'utf8')) as {
    rules: {
      action_parameters: { vary: { default: { action: string }; headers: Record<string, { action: string }> } };
    }[];
  }
).rules[0]?.action_parameters as { vary: { default: { action: string }; headers: Record<string, { action: string }> } };

/** The limiter's answer for every rule: allow, suspicious (flag rules tripped) or deny (429). */
let limiterMode: 'allow' | 'suspicious' | 'deny' = 'allow';
const result = () => ({
  allowed: limiterMode !== 'deny',
  limit: 1,
  remaining: limiterMode === 'deny' ? 0 : 1,
  retryAfterSeconds: limiterMode === 'deny' ? 30 : 0,
  resetAtMs: 0,
  ...(limiterMode === 'suspicious' ? { tripped: true } : {}),
});
const limiter = {
  consume: async () => result(),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) => checks.map(() => result()),
} as unknown as RateLimiter;

let app: Awaited<ReturnType<typeof buildApp>>;
let a: Founder;
let b: Founder;
let country = '';
/** Secret keys of site A (agency a) and site B (agency b); the widget key of site A. */
const K = { a: '', b: '', widget: '' };
const A = { listing: '', second: '', site: '', key: '' };
const WIDGET_ORIGIN = 'https://www.edge-a.example';

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
  source: 'HIT' | 'MISS' | 'STALE' | 'BYPASS' | 'DOWN';
}

/** Cloudflare's cache for the website API host, as the repository's cache rule sets it up. */
class EdgeModel {
  private readonly entries = new Map<
    string,
    { vary: [string, string][]; answer: Omit<Answer, 'source'>; storedAt: number; fresh: number; ifError: number }[]
  >();
  now = 0;
  originDown = false;

  private static baseKey(url: string): string {
    const u = new URL(url, 'https://feed.example');
    const params = [...u.searchParams.entries()].sort(([x, y], [p, q]) =>
      x === p ? y.localeCompare(q) : x.localeCompare(p),
    );
    return `${u.pathname}?${new URLSearchParams(params).toString()}`;
  }

  async get(url: string, headers: Record<string, string>): Promise<Answer> {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const variants = this.entries.get(EdgeModel.baseKey(url)) ?? [];
    const match = variants.find((v) => v.vary.every(([name, value]) => (lower[name] ?? '') === value));
    if (match && this.now - match.storedAt <= match.fresh) return { ...match.answer, source: 'HIT' };
    if (this.originDown) {
      if (match && this.now - match.storedAt <= match.fresh + match.ifError)
        return { ...match.answer, source: 'STALE' };
      return { status: 502, headers: {}, body: '', source: 'DOWN' };
    }
    const res = await app.inject({ method: 'GET', url, headers });
    const answer = {
      status: res.statusCode,
      headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])),
      body: res.body,
    };
    const stored = this.store(url, lower, answer);
    return { ...answer, source: stored ? 'MISS' : 'BYPASS' };
  }

  /** `edge_ttl: bypass_by_default` + the rule's `vary` actions. */
  private store(url: string, req: Record<string, string>, answer: Omit<Answer, 'source'>): boolean {
    const cc = answer.headers['cache-control'] ?? '';
    const sMaxAge = /s-maxage=(\d+)/.exec(cc)?.[1];
    if (answer.status !== 200 || !/\bpublic\b/.test(cc) || /\b(private|no-store)\b/.test(cc) || !sMaxAge) return false;
    const names = (answer.headers.vary ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const vary: [string, string][] = [];
    for (const name of names) {
      const action = (RULE.vary.headers[name] ?? RULE.vary.default).action;
      if (action === 'bypass') return false;
      if (action === 'passthrough') vary.push([name, req[name] ?? '']);
    }
    const key = EdgeModel.baseKey(url);
    const others = (this.entries.get(key) ?? []).filter((v) => JSON.stringify(v.vary) !== JSON.stringify(vary));
    others.push({
      vary,
      answer,
      storedAt: this.now,
      fresh: Number(sMaxAge) * 1_000,
      ifError: Number(/stale-if-error=(\d+)/.exec(cc)?.[1] ?? 0) * 1_000,
    });
    this.entries.set(key, others);
    return true;
  }
}

const asMember = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function publicListing(m: Founder, ids: { city: string; villa: string }, priceCents: number): Promise<string> {
  const { id } = await asMember(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents, energyRating: 'B' }),
    ),
  );
  await asMember(m, async (ctx) =>
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
  await withSystem('feed-api.edge.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  return id;
}

const SITE: CreateSiteInput = {
  name: 'Edge A',
  domains: ['www.edge-a.example'],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: 'EA',
  locales: ['en', 'es'],
  contact: null,
};

async function keyFor(m: Founder, siteId: string, kind: 'SECRET' | 'PUBLISHABLE') {
  return asMember(m, (ctx) =>
    identity.createApiKey(ctx, {
      name: kind,
      kind,
      scopes: ['listings:read', 'taxonomy:read'],
      allowedOrigins: kind === 'PUBLISHABLE' ? [WIDGET_ORIGIN] : [],
      siteId,
    }),
  );
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:feed-edge:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-key-0123456789abcdef0123456789' });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  [a, b] = [await createFounder(), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await withSystem('feed-api.edge.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-fe-${RUN}` }];
    const c = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `fe-${RUN}`,
      translations: name('Edgia'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: await taxonomy.createLocation(tx, {
        level: 'REGION',
        parentId: c,
        code: `fe-r-${RUN}`,
        translations: name('Ridge'),
      }),
      code: `fe-c-${RUN}`,
      translations: name('Ledge'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `fe-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `fe-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { c, city, villa };
  });
  country = ids.c;
  A.listing = await publicListing(a, ids, 30_000_000);
  A.second = await publicListing(a, ids, 20_000_000);
  await publicListing(b, ids, 40_000_000);
  A.site = (await asMember(a, (ctx) => websites.createSite(ctx, SITE))).id;
  const siteB = (
    await asMember(b, (ctx) => websites.createSite(ctx, { ...SITE, name: 'Edge B', referencePrefix: 'EB' }))
  ).id;
  const issued = await keyFor(a, A.site, 'SECRET');
  K.a = issued.secret;
  A.key = issued.key.id;
  K.b = (await keyFor(b, siteB, 'SECRET')).secret;
  K.widget = (await keyFor(a, A.site, 'PUBLISHABLE')).secret;
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter,
    checks: {},
    edgeCache: true,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

/** A URL with the `_k` edge token of `key` (and browser `origin`), as the SDK sends it. */
const withK = (url: string, key: string, origin?: string) =>
  `${url}${url.includes('?') ? '&' : '?'}_k=${edgeKeyToken(key, origin)}`;
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { 'x-api-key': K.a, ...headers } });
const refOf = async (id: string) => (await asMember(a, (ctx) => properties.getListing(ctx, id))).ref as string;

describe('website API edge caching (S7-06)', () => {
  it('[S7-06] first pages and details with their key token are public for the CDN: s-maxage, stale-while-revalidate, stale-if-error 24 h, strong ETag, Cache-Tags', async () => {
    const urls: [string, number][] = [
      [`/v2/listings?locations=${country}`, WEBSITE_API_TTL.listings],
      [`/v2/listings/${encodeURIComponent(await refOf(A.listing))}?lang=en`, WEBSITE_API_TTL.detail],
      ['/v2/sitemap', WEBSITE_API_TTL.sitemap],
      [`/v2/developments?locations=${country}`, WEBSITE_API_TTL.developments],
    ];
    for (const [url, ttl] of urls) {
      const res = await get(withK(url, K.a));
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe(
        `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl}, stale-if-error=86400`,
      );
      // The cache rule passes these through into the cache key; the origin is in the URL (`_k`).
      expect(res.headers.vary, url).toBe('Accept-Encoding, X-Api-Key, Authorization');
      expect(res.headers.etag, url).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
      const tags = String(res.headers['cache-tag']).split(',');
      expect(tags, url).toEqual(
        expect.arrayContaining([websiteApi.edgeTag('s', A.site), websiteApi.edgeTag('k', A.key)]),
      );
      // Revalidation (Cloudflare's If-None-Match) keeps the same policy.
      const again = await get(withK(url, K.a), { 'if-none-match': res.headers.etag as string });
      expect(again.statusCode, url).toBe(304);
      expect(again.headers['cache-control'], url).toBe(res.headers['cache-control']);
      // Without the token, with another key's token or twice: private (nothing cacheable even under a zone-wide rule).
      for (const variant of [url, withK(url, K.b), `${withK(url, K.a)}&_k=${edgeKeyToken(K.a)}`]) {
        // (A repeated `_k` fails validation: 422, never stored either.)
        const priv = await get(variant);
        expect(String(priv.headers['cache-control']), variant).toMatch(/^private, /);
        expect(priv.headers['cache-tag'], variant).toBeUndefined();
      }
    }
    // A sitemap TTL within the purge horizon's bound; the horizon is twice the longest lifetime.
    expect(WEBSITE_API_TTL.sitemap).toBeLessThanOrEqual(240);
    expect(websiteApi.EDGE_PURGE_HORIZON_MS).toBe(2 * 300 * 1_000);
    // Pages and details name what they show: an edit of either listing purges them.
    const page = await get(withK(`/v2/listings?locations=${country}`, K.a));
    expect(String(page.headers['cache-tag']).split(',')).toEqual(
      expect.arrayContaining([websiteApi.edgeTag('t', A.listing), websiteApi.edgeTag('t', A.second)]),
    );
    // Taxonomy is the same for every site; its copies are still keyed by the key that fetched them, and a URL with an
    // unknown parameter (its schema strips them) is not a second cacheable copy.
    const tax = await get('/v2/taxonomy/catalog');
    expect(tax.headers.vary).toBe('Accept-Encoding, X-Api-Key, Authorization');
    expect((await get('/v2/taxonomy/catalog?bust=1')).headers['cache-control']).toBe(
      'private, max-age=0, must-revalidate',
    );
  });

  it('[S7-06] the edge cache is keyed by site and key: a cached answer never reaches another site, key, browser origin or a keyless caller', async () => {
    const edge = new EdgeModel();
    const url = withK(`/v2/listings?locations=${country}&sort=newest`, K.a);
    const first = await edge.get(url, { 'x-api-key': K.a });
    expect(first.source).toBe('MISS');
    expect((await edge.get(url, { 'x-api-key': K.a })).source).toBe('HIT');
    // The same query in another order: the rule sorts the query string.
    const reordered = `/v2/listings?_k=${edgeKeyToken(K.a)}&sort=newest&locations=${country}`;
    expect((await edge.get(reordered, { 'x-api-key': K.a })).source).toBe('HIT');
    // Site B's key on A's URL: another cache key (the key header), and the origin answers it privately (A's token).
    const onA = await edge.get(url, { 'x-api-key': K.b });
    expect(onA.source).toBe('BYPASS');
    // Site B with its own token: its own entry, with site B's inventory.
    const other = await edge.get(withK(`/v2/listings?locations=${country}&sort=newest`, K.b), { 'x-api-key': K.b });
    expect(other.source).toBe('MISS');
    const refs = (body: string) => (JSON.parse(body) as { items: { ref: string }[] }).items.map((i) => i.ref);
    expect(refs(other.body)).toHaveLength(1);
    expect(refs(first.body)).toHaveLength(2);
    expect(refs(first.body)).not.toContain(refs(other.body)[0]);
    expect(refs(onA.body)).toEqual(refs(other.body));
    // Site A's widget key (another key of the same site) from its browser origin: its own URL and entry.
    const widgetUrl = withK(`/v2/listings?locations=${country}&sort=newest`, K.widget, WIDGET_ORIGIN);
    const widget = await edge.get(widgetUrl, { 'x-api-key': K.widget, origin: WIDGET_ORIGIN });
    expect(widget.source).toBe('MISS');
    expect(widget.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    expect(widget.headers.vary).toBe('Accept-Encoding, X-Api-Key, Authorization');
    // Another origin with the widget's URL is not served the widget's copy's origin: the token names the origin.
    const evilUrl = withK(`/v2/listings?locations=${country}&sort=newest`, K.widget, 'https://evil.example');
    expect((await edge.get(evilUrl, { 'x-api-key': K.widget, origin: 'https://evil.example' })).status).toBe(403);
    // A browser origin without a token of its own: private, and `Vary: Origin` makes the rule bypass it.
    const noToken = await edge.get(`/v2/listings?locations=${country}`, {
      'x-api-key': K.widget,
      origin: WIDGET_ORIGIN,
    });
    expect([noToken.source, noToken.headers.vary]).toEqual([
      'BYPASS',
      'Accept-Encoding, X-Api-Key, Authorization, Origin',
    ]);
    // The key in the other header is another entry; no key at all reaches the origin and is refused.
    expect((await edge.get(url, { authorization: `Bearer ${K.a}` })).source).toBe('MISS');
    const keyless = await edge.get(url, {});
    expect([keyless.source, keyless.status]).toEqual(['BYPASS', 401]);
  });

  it('[S7-06] cursor pages (an empty cursor too), /v2/changes, suspicious callers, errors and 429s are never edge-cached', async () => {
    const edge = new EdgeModel();
    const first = (await get(`/v2/listings?locations=${country}&limit=1`)).json() as { nextCursor: string };
    expect(first.nextCursor).toBeTruthy();
    const deep = withK(`/v2/listings?locations=${country}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, K.a);
    const paged = await edge.get(deep, { 'x-api-key': K.a });
    expect(paged.status).toBe(200);
    expect(paged.source).toBe('BYPASS');
    expect(paged.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(paged.headers['cache-tag']).toBeUndefined();
    // An empty `cursor=` is refused or private — never a cacheable first page.
    const empty = await edge.get(withK(`/v2/sitemap?cursor=`, K.a), { 'x-api-key': K.a });
    expect(empty.source).toBe('BYPASS');
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const changes = await edge.get(withK(`/v2/changes?since=${encodeURIComponent(since)}`, K.a), { 'x-api-key': K.a });
    expect([changes.status, changes.source]).toEqual([200, 'BYPASS']);
    expect(changes.headers['cache-tag']).toBeUndefined();
    limiterMode = 'suspicious';
    try {
      // A suspected scraper's deep page (it may carry a honeytoken): never stored anywhere.
      const widgetDeep = withK(
        `/v2/listings?locations=${country}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        K.widget,
        WIDGET_ORIGIN,
      );
      const flagged = await edge.get(widgetDeep, { 'x-api-key': K.widget, origin: WIDGET_ORIGIN });
      expect([flagged.status, flagged.source, flagged.headers['cache-control']]).toEqual([
        200,
        'BYPASS',
        'private, no-store',
      ]);
      expect(flagged.headers.etag).toBeUndefined();
    } finally {
      limiterMode = 'allow';
    }
    // Rate limits and quotas: the origin's answer for that moment only.
    limiterMode = 'deny';
    try {
      const limited = await edge.get(withK(`/v2/listings?locations=${country}&limit=2`, K.a), { 'x-api-key': K.a });
      expect([limited.status, limited.source, limited.headers['cache-control']]).toEqual([
        429,
        'BYPASS',
        'private, no-store',
      ]);
    } finally {
      limiterMode = 'allow';
    }
    for (const url of ['/v2/listings/EA-NOPE-1', '/v2/listings?lang=de']) {
      const err = await edge.get(withK(url, K.a), { 'x-api-key': K.a });
      expect(err.status, url).toBeGreaterThanOrEqual(400);
      expect([err.source, err.headers['cache-control'], err.headers['cache-tag']], url).toEqual([
        'BYPASS',
        'private, no-store',
        undefined,
      ]);
    }
  });

  it("[S7-06] a flagged caller's first page is the answer every caller of the key gets (no honeytoken), so caching it leaks nothing", async () => {
    // Suspicion is decided on paged requests only (S7-04: first pages keep working), and honeytokens only replace cards
    // on deep pages (cursor, depth ≥ 10): a first page carries none, whoever asks. Suspicious answers are no-store
    // (the deep-page case above); a first page stays the key's shared answer.
    const url = withK(`/v2/listings?locations=${country}&limit=2`, K.widget, WIDGET_ORIGIN);
    const headers = { 'x-api-key': K.widget, origin: WIDGET_ORIGIN };
    const normal = await get(url, headers);
    limiterMode = 'suspicious';
    try {
      const flagged = await get(url, headers);
      expect(flagged.statusCode).toBe(200);
      expect(flagged.body).toBe(normal.body);
      expect(flagged.headers.etag).toBe(normal.headers.etag);
    } finally {
      limiterMode = 'allow';
    }
  });

  it('[S7-06] origin stopped: the edge keeps serving cached answers for 24 h (stale-if-error), uncached ones fail', async () => {
    const edge = new EdgeModel();
    const detail = withK(`/v2/listings/${encodeURIComponent(await refOf(A.listing))}`, K.a);
    const cached = await edge.get(detail, { 'x-api-key': K.a });
    expect(cached.source).toBe('MISS');
    edge.originDown = true;
    edge.now = 3_600_000;
    const stale = await edge.get(detail, { 'x-api-key': K.a });
    expect([stale.source, stale.status, stale.body]).toEqual(['STALE', 200, cached.body]);
    edge.now = 23 * 3_600_000;
    expect((await edge.get(detail, { 'x-api-key': K.a })).source).toBe('STALE');
    edge.now = 25 * 3_600_000;
    expect((await edge.get(detail, { 'x-api-key': K.a })).source).toBe('DOWN');
    expect((await edge.get(withK('/v2/sitemap', K.a), { 'x-api-key': K.a })).source).toBe('DOWN');
  });
});
