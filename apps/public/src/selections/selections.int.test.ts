import { CreateListingBody, CreateSelectionBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as presentations from '@inmolink/core/modules/presentations';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder, type Founder, whiteLabelLeaks, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { selectionActionResponse, selectionResponse } from './handlers';

/**
 * The selection page as served (S12-04): `GET /s/<token>` — white-labelled HTML with no JavaScript, never cached, no
 * referrer, nothing may frame it, live prices; a view counted once per browser and never for link-preview bots;
 * `POST /s/<token>` — likes and enquiries from the page itself (cross-site posts refused), answered by a 303.
 */

vi.mock('@/server/embed', () => ({
  clientAddress: async () => ({ ip: '203.0.113.7', bucket: `203.0.113.7-${Math.random()}` }),
  embedPageConfig: async () => ({ mediaOrigin: 'https://media.example', turnstileSiteKey: null }),
}));
vi.mock('@/server/env', () => ({ publicConfig: async () => ({ NODE_ENV: 'test' }) }));

const RUN = newId().slice(-8);
const OWNER_NAME = `Ownerhaus Pagina ${RUN}`;
const OWNER_MAIL = `sales-${RUN.toLowerCase()}@ownerhaus-pagina.example`;
const code = (s: string) => `${s}-selp-${RUN}`;
const BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';

let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };
let bListing = '';
let selectionId = '';
let token = '';

const as = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

const get = (path: string, headers: Record<string, string> = {}) =>
  selectionResponse(
    new Request(`https://sites.test${path}`, { headers: { 'user-agent': BROWSER, ...headers } }),
    token,
  );
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  selectionActionResponse(
    new Request(`https://sites.test/s/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://sites.test', ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    token,
  );

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:sel-page:${RUN}`, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef',
  });
  presentations.configurePresentations({
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
    publicBaseUrl: 'https://sites.test',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  a = await createFounder();
  b = await createFounder({ companyName: OWNER_NAME });
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await withSystem('selp.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Pageland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Port'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('v'),
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const { id } = await as(b, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 45_000_000,
        energyRating: 'B',
      }),
    ),
  );
  bListing = id;
  for (const locale of ['en', 'es']) {
    await as(b, async (ctx) =>
      properties.saveListingTranslation(ctx, id, locale, {
        version: (await properties.getListing(ctx, id)).version,
        title: `${OWNER_NAME} villa`,
        description: `Sea views. Call ${OWNER_NAME} on +34 955 512 345 or mail ${OWNER_MAIL}.`,
      }),
    );
  }
  await as(b, async (ctx) =>
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
  await withSystem('selp.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  const made = await as(a, (ctx) =>
    presentations.createSelection(
      ctx,
      CreateSelectionBody.parse({
        title: 'Villas for Ana',
        message: 'My picks',
        locale: 'en',
        items: [{ targetId: id, note: `<b>${OWNER_NAME}</b>` }],
      }),
    ),
  );
  selectionId = made.selection.id;
  token = made.share.token;
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

const views = async () => (await as(a, (ctx) => presentations.getSelection(ctx, selectionId))).stats.views;

describe('selection page as served (S12-04)', () => {
  it('[S12-04] the page passes the white-label test, has no JavaScript, is never cached, leaks no referrer and cannot be framed', async () => {
    const res = await get(`/s/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const ownerRef = (await as(b, (ctx) => properties.getListing(ctx, bListing))).ref as string;
    expect(
      whiteLabelLeaks(html, {
        name: OWNER_NAME,
        email: OWNER_MAIL,
        domain: 'ownerhaus-pagina.example',
        ref: ownerRef,
        phone: '+34 955 512 345',
        phoneDigits: '955512345',
        agencyId: b.agencyId,
      }),
    ).toEqual([]);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('Villas for Ana');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('set-cookie')).toMatch(
      new RegExp(`^seen=1; Path=/s/${token}; Max-Age=\\d+; HttpOnly; SameSite=Lax`),
    );
  });

  it('[S12-04] a view is counted once per browser, never for link-preview bots', async () => {
    const before = await views();
    await get(`/s/${token}`, { cookie: 'seen=1' });
    await get(`/s/${token}`, { 'user-agent': 'WhatsApp/2.23.20.0 A' });
    await get(`/s/${token}`, { 'user-agent': 'facebookexternalhit/1.1' });
    expect(await views()).toBe(before);
    await get(`/s/${token}`);
    expect(await views()).toBe(before + 1);
  });

  it('[S12-04] a like and an enquiry from the page are recorded; a cross-site post is refused', async () => {
    const liked = await post({ action: 'like', item: bListing });
    expect(liked.status).toBe(303);
    expect(liked.headers.get('location')).toBe(`/s/${token}?n=liked#item-${bListing}`);
    const cookie = (liked.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(cookie).toBe(`liked=${bListing}`);
    const page = await (await get(`/s/${token}?n=liked`, { cookie: `seen=1; ${cookie}` })).text();
    expect(page).toContain('Remove like');
    expect(page).toContain('your agent can see you like this property');
    const sent = await post({ action: 'enquire', item: bListing, message: 'Can I visit on Friday?' });
    expect(sent.headers.get('location')).toBe(`/s/${token}?n=sent#item-${bListing}`);
    expect((await post({ action: 'enquire', message: '' })).headers.get('location')).toBe(`/s/${token}?n=invalid`);
    const cross = await post({ action: 'like', item: bListing }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const got = await as(a, (ctx) => presentations.getSelection(ctx, selectionId));
    expect(got.items[0]).toMatchObject({ likes: 1, enquiries: 1 });
  });

  it('[S12-04] an owner price change shows on the page on the next view', async () => {
    await as(b, async (ctx) =>
      properties.updateListing(
        ctx,
        bListing,
        UpdateListingBody.parse({
          priceCents: 39_900_000,
          version: (await properties.getListing(ctx, bListing)).version,
        }),
      ),
    );
    await withSystem('selp.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [bListing]));
    const html = await (await get(`/s/${token}`, { cookie: 'seen=1' })).text();
    expect(html).toContain('€399,000');
    expect(html).not.toContain('€450,000');
  });

  it('[S12-04] an unknown or revoked link is a gone page (404), nothing recorded', async () => {
    const unknown = await selectionResponse(new Request(`https://sites.test/s/${'x'.repeat(43)}`), 'x'.repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('This selection is no longer available');
    const version = (await as(a, (ctx) => presentations.getSelection(ctx, selectionId))).version;
    await as(a, (ctx) => presentations.updateSelection(ctx, selectionId, { version, expiresInDays: null }));
    expect((await get(`/s/${token}`)).status).toBe(404);
    expect((await post({ action: 'like', item: bListing })).status).toBe(404);
  });
});
