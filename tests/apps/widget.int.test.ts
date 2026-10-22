import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { type Browser, chromium } from '@playwright/test';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/feed-api/src/app';
import { buildWidget } from '../../packages/sdk/widget-build';

/**
 * The JS widget in a real browser (S8-06): a plain HTML page on an allowlisted origin loads the built script, searches
 * the real feed-api (Postgres fallback) and opens a listing; a page on another origin is refused. Needs Chromium
 * (`pnpm exec playwright install chromium`); CI's Integration job installs it.
 */

const RUN = newId().slice(-8);
const SECRET_NOTE = `owner-note-${RUN}`;
const allow = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

let app: Awaited<ReturnType<typeof buildApp>>;
let apiOrigin: string;
let publishableKey: string;
let ref: string;
let networkRef: string;
let presentingName: string;
let ownerName: string;
let browser: Browser;
let script: string;
let allowed: string;
let other: string;
const servers: Server[] = [];
const outDir = mkdtempSync(join(tmpdir(), 'inmolink-widget-'));

/** A static page server on `localhost:<port>`: that origin is what the browser sends. */
function pageServer(html: () => string): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/widget.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
      else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html());
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://localhost:${(server.address() as AddressInfo).port}`));
  });
}

const pageHtml =
  () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plain page</title></head><body>
<h1>My agency site</h1><div data-inmolink-widget></div>
<script src="/widget.js" data-api-key="${publishableKey}" data-base-url="${apiOrigin}"></script></body></html>`;

beforeAll(async () => {
  script = readFileSync(await buildWidget(outDir), 'utf8');
  await setupTestDb('worker');
  await configureCache({ prefix: `t:widget:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  // Give-to-get: the site's agency shares one listing with the network, no grace period.
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  const a: Founder = await createFounder();
  const b: Founder = await createFounder();
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const as = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
    withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
  const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
  // Founders share a default agency name: give the owner its own, so a leak of it is detectable.
  await withSystem('widget.test', (tx) =>
    tx.execute(sql`update agencies set name = ${`Hidden Owner ${RUN} S.L.`} where agency_id = ${b.agencyId}`),
  );
  const ids = await withSystem('widget.test', async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `wg-${RUN}`,
      translations: name('Widgetland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: `wg-r-${RUN}`,
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: `wg-c-${RUN}`,
      translations: name('Delta'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `wg-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `wg-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const publish = async (m: Founder, body: Record<string, unknown>) => {
    const { id } = await as(m, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 30_000_000,
          energyRating: 'B',
          ...body,
        }),
      ),
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
    await withSystem('widget.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
    return id;
  };
  const ownId = await publish(a, {});
  // The network owner's listing carries commission and an internal note: neither may reach the widget.
  const networkId = await publish(b, {
    priceCents: 40_000_000,
    commission: { type: 'PCT', basisPoints: 450, includesVat: false },
    internalNotes: SECRET_NOTE,
  });
  ref = (await as(a, (ctx) => properties.getListing(ctx, ownId))).ref as string;
  const code = (await withSystem('widget.test', (tx) => search.publicCodes(tx, [networkId]))).get(networkId) as string;
  networkRef = `WS-${code}`;
  const names = await withSystem('widget.test', (tx) =>
    tx.execute<{ id: string; name: string }>(
      sql`select agency_id as id, name from agencies where agency_id in (${a.agencyId}, ${b.agencyId})`,
    ),
  );
  presentingName = names.rows.find((r) => r.id === a.agencyId)?.name as string;
  ownerName = names.rows.find((r) => r.id === b.agencyId)?.name as string;
  const site = await as(a, (ctx) =>
    websites.createSite(ctx, {
      name: 'Widget site',
      domains: ['www.widget-site.example'],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_PLUS_NETWORK',
      inventoryFilters: null,
      referencePrefix: 'WS',
      locales: ['en'],
      contact: null,
    }),
  );
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allow,
    checks: {},
  });
  await app.listen({ port: 0, host: 'localhost' });
  // The widget accepts http only for the name `localhost`.
  apiOrigin = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  allowed = await pageServer(pageHtml);
  other = await pageServer(pageHtml);
  publishableKey = (
    await as(a, (ctx) =>
      identity.createApiKey(ctx, {
        name: 'Widget',
        kind: 'PUBLISHABLE',
        scopes: ['listings:read'],
        allowedOrigins: [allowed],
        siteId: site.id,
      }),
    )
  ).secret;
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
  rmSync(outDir, { recursive: true, force: true });
  await app?.close();
  await closeCache();
  await closeDb();
});

describe('JS widget in a browser (S8-06)', () => {
  it('[S8-06] works on a plain HTML page with an allowlisted origin', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      const status = widget.locator('[role=status]').first();
      const card = widget.locator('.card', { hasText: `Ref. ${ref}` });
      // The shared test database holds other listings: find ours by its reference.
      await widget.locator('input[name=q]').fill(ref);
      await widget.locator('button[type=submit]').click();
      await card.waitFor({ timeout: 20_000 });
      expect(await card.innerText()).toMatch(/300,000/);
      expect(await status.innerText()).toMatch(/propert/);

      // A price ceiling below it excludes it (euros typed, cents sent), without the ceiling it is back.
      await widget.locator('input[name=priceMax]').fill('1');
      await widget.locator('button[type=submit]').click();
      await status.filter({ hasText: /No properties/ }).waitFor({ timeout: 20_000 });
      await widget.locator('input[name=priceMax]').fill('');
      await widget.locator('button[type=submit]').click();
      await card.waitFor({ timeout: 20_000 });

      // The detail modal: labelled by its heading, the rest of the widget inert, Escape closes and is consumed.
      await page.evaluate(() => {
        (window as unknown as { escapeSeenByPage: boolean }).escapeSeenByPage = false;
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') (window as unknown as { escapeSeenByPage: boolean }).escapeSeenByPage = true;
        });
      });
      await card.locator('button').click();
      const dialog = widget.locator('[role=dialog]');
      await dialog.locator('h3', { hasText: /Contact/ }).waitFor({ timeout: 20_000 });
      expect(await dialog.getAttribute('aria-labelledby')).toBeTruthy();
      expect(await widget.locator('[part=widget]').evaluate((n) => (n as HTMLElement).inert)).toBe(true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await widget.locator('[part=widget]').evaluate((n) => (n as HTMLElement).inert)).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { escapeSeenByPage: boolean }).escapeSeenByPage)).toBe(
        false,
      );
    } finally {
      await page.close();
    }
  }, 120_000);

  it('[S8-06] white-label: a network listing shows the presenting agency only, no owner, commission or notes', async () => {
    const detail = await fetch(`${apiOrigin}/v2/listings/${encodeURIComponent(networkRef)}`, {
      headers: { 'x-api-key': publishableKey, origin: allowed },
    });
    expect(detail.status).toBe(200);
    const json = await detail.text();
    expect(JSON.parse(json).agency.name).toBe(presentingName);
    for (const leak of [ownerName, SECRET_NOTE, 'commission', 'internalNotes', 'ownerAgency', 'owner']) {
      expect(json.toLowerCase().includes(leak.toLowerCase()), leak).toBe(false);
    }

    const page = await browser.newPage();
    try {
      await page.goto(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      const card = widget.locator('.card', { hasText: `Ref. ${networkRef}` });
      await widget.locator('input[name=q]').fill(networkRef);
      await widget.locator('button[type=submit]').click();
      await card.waitFor({ timeout: 20_000 });
      await card.locator('button').click();
      const dialog = widget.locator('[role=dialog]');
      await dialog.locator('h3', { hasText: new RegExp(`Contact: ${presentingName}`) }).waitFor({ timeout: 20_000 });
      const text = (await dialog.innerText()).toLowerCase();
      for (const leak of [ownerName, SECRET_NOTE, 'commission'])
        expect(text.includes(leak.toLowerCase()), leak).toBe(false);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('[S8-06] a page on a non-allowlisted origin is refused by the API and the widget reports the refusal', async () => {
    const direct = await fetch(`${apiOrigin}/v2/listings`, {
      headers: { 'x-api-key': publishableKey, origin: other },
    });
    expect(direct.status).toBe(403);
    expect(((await direct.json()) as { error: { code: string } }).error.code).toBe('API_KEY_ORIGIN_DENIED');

    const page = await browser.newPage();
    try {
      // The widget reports failures as a bubbling `inmolink:error` event; listen before the script runs.
      await page.addInitScript(() => {
        (window as unknown as { widgetErrors: string[] }).widgetErrors = [];
        document.addEventListener('inmolink:error', (e) =>
          (window as unknown as { widgetErrors: string[] }).widgetErrors.push((e as CustomEvent).detail.code),
        );
      });
      await page.goto(other);
      const widget = page.locator('[data-inmolink-widget]');
      await widget.locator('.error').waitFor({ timeout: 20_000 });
      expect(await widget.locator('.card').count()).toBe(0);
      // The 403 carries no CORS header for a refused origin, so the browser hides it: a network-level failure.
      expect(await page.evaluate(() => (window as unknown as { widgetErrors: string[] }).widgetErrors)).toEqual([
        'NETWORK',
      ]);
    } finally {
      await page.close();
    }
  }, 120_000);
});
