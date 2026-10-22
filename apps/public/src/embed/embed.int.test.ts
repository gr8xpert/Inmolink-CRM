import { CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { countQueries, createFounder, type Founder, whiteLabelLeaks, withSystem } from '@inmolink/core/test';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMBED_SCRIPT_PATH } from './client';
import { EMBED_GATE_HEADER } from './csp';
import { gateMarker, minuteOf } from './gate';
import { detailResponse, EMBED_PAGE_CACHE, leadResponse, searchResponse } from './handlers';

/**
 * The iFrame embed routes as served (S7-F8): server-rendered HTML with no framework JavaScript, the site's
 * frame-ancestors, cacheable per URL, white-labelled (the shared S7-02 check on the rendered detail page and result
 * cards); the routes require the proxy's gate marker and check the site again; an enquiry posted from the page reaches
 * the presenting agency.
 */

const { KEY } = vi.hoisted(() => ({ KEY: 'test-embed-gate-key-0123456789abcdef' }));
// The app's server module, without its env loading: the gate marker with a test key, a fixed client and config.
vi.mock('@/server/embed', async () => {
  const core = await import('@inmolink/core/modules/website-api');
  const { isAppError } = await import('@inmolink/platform/errors');
  const gate = await import('./gate');
  return {
    clientAddress: async () => ({ ip: '203.0.113.9', bucket: `203.0.113.9-${Math.random()}` }),
    passedGate: async (siteId: string, marker: string | null) => gate.gateMarkerValid(KEY, siteId, marker, Date.now()),
    embedSiteFor: async (siteId: string) => {
      try {
        return await core.embedSite(siteId, 'test');
      } catch (err) {
        if (isAppError(err) && err.code === 'SITE_NOT_FOUND') return null;
        throw err;
      }
    },
    embedPageConfig: async () => ({
      mediaOrigin: 'https://media.example',
      turnstileSiteKey: '1x00000000000000000000AA',
    }),
  };
});

const marker = (siteId: string) => gateMarker(KEY, siteId, minuteOf(Date.now()));
const get = (path: string, siteId: string, headers: Record<string, string> = {}) =>
  new Request(`https://sites.test${path}`, { headers: { [EMBED_GATE_HEADER]: marker(siteId), ...headers } });
const turnstile: TurnstileVerifier = {
  async verify(token, options) {
    return token.startsWith('good') && (options.hostnames ?? []).includes('sites.test');
  },
};
let wpSiteId = '';

const RUN = newId().slice(-8);
const OWNER_NAME = `Ownerhaus Frame ${RUN}`;
const OWNER_MAIL = `sales-${RUN.toLowerCase()}@ownerhaus-frame.example`;
let a: Founder;
let b: Founder;
let siteId = '';
let bListing = '';

const as = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:embed-page:${RUN}` });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef',
    turnstile,
    embedOrigin: 'https://sites.test',
  });
  websiteApi.configureEdgeCache({ tagKey: 'test-edge-key-0123456789abcdef0123456789' });
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  a = await createFounder();
  b = await createFounder({ companyName: OWNER_NAME });
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await withSystem('embed-page.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-ep-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ep-${RUN}`,
      translations: name('Frameland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `ep-r-${RUN}`,
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `ep-c-${RUN}`,
      translations: name('Harbour'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `ep-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `ep-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { country, city, villa };
  });
  const listing = async (m: Founder, priceCents: number, title: string, description: string) => {
    const { id } = await as(m, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents, energyRating: 'B' }),
      ),
    );
    await as(m, async (ctx) =>
      properties.saveListingTranslation(ctx, id, 'en', {
        version: (await properties.getListing(ctx, id)).version,
        title,
        description,
      }),
    );
    await as(m, async (ctx) =>
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
    return id;
  };
  bListing = await listing(
    b,
    45_000_000,
    `Villa by the sea ${RUN}`,
    `Call ${OWNER_NAME} at ${OWNER_MAIL} or visit www.ownerhaus-frame.example today.`,
  );
  // The site agency shares a listing too (give-to-get: network listings show only then).
  const own = await listing(a, 30_000_000, `Own villa ${RUN}`, 'Sunny villa.');
  await withSystem('embed-page.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [bListing, own]));
  siteId = (
    await as(a, (ctx) =>
      websites.createSite(ctx, {
        name: 'Frame site',
        domains: ['www.frame-site.example'],
        mode: 'IFRAME',
        inventoryPolicy: 'CUSTOM',
        inventoryFilters: {
          includeOwn: true,
          includeNetwork: true,
          locationIds: [ids.country],
          propertyTypeIds: [],
          newBuilds: true,
        },
        referencePrefix: 'FS',
        locales: ['en'],
        contact: { name: 'Frame Homes', email: 'hello@frame-site.example' },
      }),
    )
  ).id;
  wpSiteId = (
    await as(a, (ctx) =>
      websites.createSite(ctx, {
        name: 'Plugin site',
        domains: ['www.frame-site.example'],
        mode: 'WP_PLUGIN',
        inventoryPolicy: 'OWN_ONLY',
        inventoryFilters: null,
        referencePrefix: 'FS',
        locales: ['en'],
        contact: null,
      }),
    )
  ).id;
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

/** Every `<script>` tag of a page. */
const scripts = (html: string) => html.match(/<script[^>]*>/g) ?? [];

describe('iFrame embed routes (S7-F8)', () => {
  it('[S7-F8] the iFrame detail page of a network listing passes the white-label check, with no framework JavaScript', async () => {
    const res = await searchResponse(get(`/embed/${siteId}/en`, siteId), { site: siteId, lang: 'en' });
    expect(res.status).toBe(200);
    const results = await res.text();
    const ref = /href="\/embed\/[^"]+\/listing\/(FS-[0-9A-Z]{8})"/.exec(results)?.[1];
    expect(ref).toBeDefined();
    const detailRes = await detailResponse(get(`/embed/${siteId}/en/listing/${ref}`, siteId), {
      site: siteId,
      lang: 'en',
      ref: ref as string,
    });
    expect(detailRes.status).toBe(200);
    const html = await detailRes.text();
    const ownerRef = (await as(b, (ctx) => properties.getListing(ctx, bListing))).ref as string;
    const owner = {
      name: OWNER_NAME,
      email: OWNER_MAIL,
      domain: 'ownerhaus-frame.example',
      ref: ownerRef,
      agencyId: b.agencyId,
    };
    expect(whiteLabelLeaks(html, owner)).toEqual([]);
    expect(whiteLabelLeaks(results, owner)).toEqual([]);
    expect(html).toContain('Contact Frame Homes');
    expect(html).toContain('hello@frame-site.example');
    // Zero framework JavaScript: the detail page has the one small script from 'self'; the search page none.
    expect(scripts(html)).toEqual([`<script src="${EMBED_SCRIPT_PATH}" defer>`]);
    expect(scripts(results)).toEqual([]);
    expect(html).not.toContain('self.__next');
    // The form has no per-visitor value (the key is made in the browser): the page is cacheable per URL.
    expect(html).toContain('name="idempotencyKey" value=""');
  });

  it("[S7-F8] embed pages: static CSP with the site's frame-ancestors, no X-Frame-Options, cacheable per URL with edge tags", async () => {
    for (const res of [
      await searchResponse(get(`/embed/${siteId}/en`, siteId), { site: siteId, lang: 'en' }),
      await searchResponse(get(`/embed/${siteId}/en?priceMin=100000`, siteId), { site: siteId, lang: 'en' }),
    ]) {
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(/frame-ancestors ([^;]+)$/.exec(csp)?.[1]).toBe('https://www.frame-site.example');
      expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;");
      expect(csp).not.toContain('nonce');
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('cache-control')).toBe(EMBED_PAGE_CACHE);
      expect(res.headers.get('cache-control')).toContain('s-maxage=60, stale-while-revalidate=300');
      expect(res.headers.get('cache-tag')).toMatch(/^[a-z][0-9a-f]+(,[a-z][0-9a-f]+)*$/);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('[S7-F8] embed routes refuse (404) without the gate marker, with a forged one, and for a site that may not be embedded', async () => {
    const path = `/embed/${siteId}/en`;
    const bare = new Request(`https://sites.test${path}`);
    expect((await searchResponse(bare, { site: siteId, lang: 'en' })).status).toBe(404);
    const forged = new Request(`https://sites.test${path}`, { headers: { [EMBED_GATE_HEADER]: 'x'.repeat(43) } });
    expect((await searchResponse(forged, { site: siteId, lang: 'en' })).status).toBe(404);
    // Another site's marker does not open this one.
    const other = new Request(`https://sites.test${path}`, { headers: { [EMBED_GATE_HEADER]: marker(wpSiteId) } });
    expect((await searchResponse(other, { site: siteId, lang: 'en' })).status).toBe(404);
    // A valid marker for a WordPress site (as if the gate had been passed): the route checks the site again.
    const wp = await searchResponse(get(`/embed/${wpSiteId}/en`, wpSiteId), { site: wpSiteId, lang: 'en' });
    expect(wp.status).toBe(404);
    expect(wp.headers.get('x-frame-options')).toBe('DENY');
    // Not one of the site's languages.
    expect((await searchResponse(get(`/embed/${siteId}/de`, siteId), { site: siteId, lang: 'de' })).status).toBe(404);
  });

  it('[S7-F8] a lead posted from the embed reaches the presenting agency; a tampered site id is refused', async () => {
    const page = await (await searchResponse(get(`/embed/${siteId}/en`, siteId), { site: siteId, lang: 'en' })).text();
    const ref = /\/listing\/(FS-[0-9A-Z]{8})"/.exec(page)?.[1] as string;
    const form = (token: string) =>
      new URLSearchParams({
        idempotencyKey: `embed-${newId()}`,
        name: 'Ana Buyer',
        email: `ana-${RUN.toLowerCase()}@example.com`,
        message: 'Is it still available?',
        privacyAccepted: 'on',
        'cf-turnstile-response': token,
      });
    const post = (site: string, body: URLSearchParams, accept: string) =>
      new Request(`https://sites.test/embed/${site}/en/listing/${ref}`, {
        method: 'POST',
        headers: {
          [EMBED_GATE_HEADER]: marker(site),
          accept,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    // The script's post: JSON.
    const res = await leadResponse(post(siteId, form(`good-${newId()}`), 'application/json'), {
      site: siteId,
      lang: 'en',
      ref,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });
    const rows = await adminQuery('select agency_id, owner_agency_id, site_id from website_leads where site_id = $1', [
      siteId,
    ]);
    expect(rows).toEqual([{ agency_id: a.agencyId, owner_agency_id: b.agencyId, site_id: siteId }]);
    // A plain post (no JavaScript): redirected back with a notice; a failed challenge is explained.
    const plain = await leadResponse(post(siteId, form('bad-token'), 'text/html'), { site: siteId, lang: 'en', ref });
    expect(plain.status).toBe(303);
    // The notice page answers one visitor: never edge-cached.
    const noticePage = await detailResponse(get(`/embed/${siteId}/en/listing/${ref}?lead=TURNSTILE_FAILED`, siteId), {
      site: siteId,
      lang: 'en',
      ref,
    });
    expect(noticePage.status).toBe(200);
    expect(noticePage.headers.get('cache-control')).toBe('no-store');
    expect(noticePage.headers.get('cache-tag')).toBeNull();
    // Only urlencoded bodies: multipart is refused before anything is read.
    const multipart = new FormData();
    multipart.set('name', 'Ana');
    const refused = await leadResponse(
      new Request(`https://sites.test/embed/${siteId}/en/listing/${ref}`, {
        method: 'POST',
        headers: { [EMBED_GATE_HEADER]: marker(siteId) },
        body: multipart,
      }),
      { site: siteId, lang: 'en', ref },
    );
    expect(refused.status).toBe(415);
    // A marker from two minutes ago no longer opens the route.
    const stale = new Request(`https://sites.test/embed/${siteId}/en`, {
      headers: { [EMBED_GATE_HEADER]: gateMarker(KEY, siteId, minuteOf(Date.now()) - 2) },
    });
    expect((await searchResponse(stale, { site: siteId, lang: 'en' })).status).toBe(404);
    expect(plain.headers.get('location')).toBe(`/embed/${siteId}/en/listing/${ref}?lead=TURNSTILE_FAILED`);
    // The same post against a WordPress site's id (tampered URL, even with that id's marker): refused, nothing stored.
    const tampered = await leadResponse(post(wpSiteId, form(`good-${newId()}`), 'application/json'), {
      site: wpSiteId,
      lang: 'en',
      ref,
    });
    expect(tampered.status).toBe(404);
    expect(await adminQuery('select 1 from website_leads where site_id = $1', [wpSiteId])).toHaveLength(0);
  });
});

describe('embed page caching (S8-F2)', () => {
  const params = () => ({ site: siteId, lang: 'en' });

  it('[S8-F2] an unchanged embed page answers 304 to its ETag; a URL with an unknown parameter is private', async () => {
    const page = `/embed/${siteId}/en?priceMin=100000`;
    const res = await searchResponse(get(page, siteId), params());
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=300',
    );
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    const again = await searchResponse(get(page, siteId, { 'if-none-match': etag }), params());
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-control')).toBe(EMBED_PAGE_CACHE);
    expect(again.headers.get('content-security-policy')).toBe(res.headers.get('content-security-policy'));
    // Another tag: the whole page.
    expect((await searchResponse(get(page, siteId, { 'if-none-match': '"other"' }), params())).status).toBe(200);

    // The detail page too.
    const ref = /\/listing\/(FS-[0-9A-Z]{8})"/.exec(await res.text())?.[1] as string;
    const detailPath = `/embed/${siteId}/en/listing/${ref}`;
    const detail = await detailResponse(get(detailPath, siteId), { ...params(), ref });
    expect(detail.headers.get('cache-control')).toBe(EMBED_PAGE_CACHE);
    const detailTag = detail.headers.get('etag') as string;
    const detail304 = await detailResponse(get(detailPath, siteId, { 'if-none-match': detailTag }), {
      ...params(),
      ref,
    });
    expect(detail304.status).toBe(304);

    // Unknown parameters, free text, a cursor-less non-canonical spelling: served, but never at the edge.
    for (const url of [
      `/embed/${siteId}/en?priceMin=100000&bust=${newId()}`,
      `/embed/${siteId}/en?q=villa`,
      `/embed/${siteId}/en?priceMin=0100000`,
      `/embed/${siteId}/en?priceMin=%3100000`,
      `/embed/${siteId}/en?%70riceMin=100000`,
      `/embed/${siteId}/en?transaction=SALE+`,
      `/embed/${siteId}/en?transaction=%53ALE`,
      `/embed/${siteId}/en?`,
    ]) {
      const r = await searchResponse(get(url, siteId), params());
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      expect(r.headers.get('cache-tag')).toBeNull();
      expect(r.headers.get('etag')).toBeTruthy();
    }
    // A detail URL other than the reference as written, with no query at all: private.
    for (const [path, r] of [
      [`${detailPath}?bust=1`, ref],
      [`${detailPath}?`, ref],
      [`/embed/${siteId}/en/listing/%46${ref.slice(1)}`, ref],
    ] as const) {
      const odd = await detailResponse(get(path, siteId), { ...params(), ref: r });
      expect(odd.status, path).toBe(200);
      expect(odd.headers.get('cache-control'), path).toBe('private, max-age=0, must-revalidate');
      expect(odd.headers.get('cache-tag'), path).toBeNull();
    }
  });

  it('[S8-F2] a forged cursor redirects to the first-page URL without a search', async () => {
    // Warm: the site's scope cached, as on any page view after the first.
    await searchResponse(get(`/embed/${siteId}/en`, siteId), params());
    const siteOnly = await countQueries(() => websiteApi.embedSite(siteId, 'test'));
    // Forged (no valid MAC), refused by the contract, and well-formed and signed but its position unreadable (stale):
    // core refuses that one only after reading it.
    const stale = websiteApi.searchCursorFor(siteId, 1, 'position-gone');
    for (const cursor of ['A'.repeat(60), 'not!a!cursor', stale]) {
      let res: Response | undefined;
      const n = await countQueries(async () => {
        res = await searchResponse(
          get(`/embed/${siteId}/en?transaction=SALE&cursor=${encodeURIComponent(cursor)}`, siteId),
          params(),
        );
      });
      expect(res?.status).toBe(303);
      expect(res?.headers.get('location')).toBe(`/embed/${siteId}/en?transaction=SALE`);
      expect(res?.headers.get('cache-control')).toBe('no-store');
      // Nothing but the site lookup: no search, no read-model read.
      expect(n).toBe(siteOnly);
    }
  });

  it('[S8-F2] the embed search and detail pages stay within 3 queries', async () => {
    const page = await searchResponse(get(`/embed/${siteId}/en`, siteId), params());
    const ref = /\/listing\/(FS-[0-9A-Z]{8})"/.exec(await page.text())?.[1] as string;
    const search = await countQueries(async () => {
      expect((await searchResponse(get(`/embed/${siteId}/en?priceMin=100000`, siteId), params())).status).toBe(200);
    });
    const detail = await countQueries(async () => {
      const r = await detailResponse(get(`/embed/${siteId}/en/listing/${ref}`, siteId), { ...params(), ref });
      expect(r.status).toBe(200);
    });
    expect(search).toBeLessThanOrEqual(3);
    expect(detail).toBeLessThanOrEqual(3);
  });
});
