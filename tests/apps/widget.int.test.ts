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
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { type Browser, chromium } from '@playwright/test';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { buildApp } from '../../apps/feed-api/src/app';
import { buildWidget } from '../../packages/sdk/widget-build';

/**
 * The JS widget in a real browser (S8-06): a plain HTML page on an allowlisted origin loads the built script, searches
 * the real feed-api (Postgres fallback) and opens a listing; a page on another origin is refused. S8-F8: the detail
 * modal's lead form posts a website lead (Turnstile: Cloudflare's script is replaced by a stub page-side and the
 * verifier by a fake API-side; Cloudflare's always-pass test site key in the markup). Needs Chromium
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
let siteId: string;
let presentingId: string;
let ownerId: string;
/** Cloudflare's published always-pass test site key: the widget renders Turnstile with it. */
const TEST_SITE_KEY = '1x00000000000000000000AA';
const usedTokens = new Set<string>();
/** API side: single-use tokens the stub issues, solved for the lead action on the page's host. */
const turnstile: TurnstileVerifier = {
  async verify(token, options) {
    const fresh = !usedTokens.has(token);
    usedTokens.add(token);
    return (
      fresh && token.startsWith('good-') && options.action === 'website-lead' && options.hostnames?.[0] === 'localhost'
    );
  },
};
/** Page side: Cloudflare's script replaced by a stub that solves at once (records what it was rendered with). */
const TURNSTILE_STUB = `window.turnstile = (() => {
  const solve = (o) => setTimeout(() => o.callback('good-' + Math.random().toString(36).slice(2)), 0);
  let opts;
  return {
    render(el, o) {
      opts = o;
      window.turnstileRendered = { sitekey: o.sitekey, action: o.action, language: o.language };
      el.textContent = 'verified';
      solve(o);
      return 'w1';
    },
    reset() { window.turnstileResets = (window.turnstileResets || 0) + 1; solve(opts); },
    remove() {},
  };
})();`;
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
<script src="/widget.js" data-api-key="${publishableKey}" data-base-url="${apiOrigin}"
  data-turnstile-site-key="${TEST_SITE_KEY}" data-privacy-url="https://www.widget-site.example/privacy"></script>
</body></html>`;

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
    turnstile,
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
  presentingId = a.agencyId;
  ownerId = b.agencyId;
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
  siteId = site.id;
  app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allow,
    checks: {},
  });
  // IPv4 loopback only: Fastify listens on every address `localhost` resolves to (::1 and 127.0.0.1 on Linux), each
  // on its own random port when the port is 0, so `address()` would name just one of them.
  await app.listen({ port: 0, host: '127.0.0.1' });
  // The widget accepts http only for the name `localhost`.
  apiOrigin = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  allowed = await pageServer(pageHtml);
  other = await pageServer(pageHtml);
  publishableKey = (
    await as(a, (ctx) =>
      identity.createApiKey(ctx, {
        name: 'Widget',
        kind: 'PUBLISHABLE',
        scopes: ['listings:read', 'leads:write', 'viewing-requests:write'],
        allowedOrigins: [allowed],
        siteId: site.id,
      }),
    )
  ).secret;
  browser = await chromium.launch();
}, 240_000);

/** A page whose console output, page errors and requests are written to stderr when the test fails. */
async function newWatchedPage() {
  const page = await browser.newPage();
  // Never Cloudflare itself: the stub stands in for its Turnstile script (S8-F8).
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB }),
  );
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`console.${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => logs.push(`response: ${r.status()} ${r.url().replace(publishableKey, '<key>')}`));
  onTestFailed(() => process.stderr.write(`\n--- browser log ---\n${logs.join('\n')}\n--- end ---\n`));
  /** `goto`, then what the page looks like a second later (kept for the failure output). */
  const open = async (url: string) => {
    await page.goto(url);
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => ({
      scripts: [...document.scripts].map((x) => x.src || 'inline'),
      host: document.querySelector('[data-inmolink-widget]') ? 'present' : 'missing',
      shadow: document.querySelector('[data-inmolink-widget]')?.shadowRoot?.innerHTML.length ?? null,
      global: typeof (window as unknown as { InmolinkWidget?: unknown }).InmolinkWidget,
    }));
    logs.push(`state: ${JSON.stringify(state)}; script bytes served: ${script.length}`);
  };
  /**
   * Fills the search form, submits it and waits until that search settled: the status stops saying "Loading…" (the
   * first, unfiltered load may still show cards, so a card alone does not mean the search answered; CI race on
   * ab04529).
   */
  const search = async (fields: Record<string, string>) => {
    const widget = page.locator('[data-inmolink-widget]');
    for (const [name, value] of Object.entries(fields)) await widget.locator(`input[name=${name}]`).fill(value);
    await widget.locator('form[role=search] button[type=submit]').click();
    const status = widget.locator('[part=widget] > [role=status]');
    await expect.poll(() => status.innerText(), { timeout: 20_000 }).not.toBe('Loading…');
  };
  return Object.assign(page, { open, search });
}

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
    const page = await newWatchedPage();
    try {
      await page.open(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      const status = widget.locator('[part=widget] > [role=status]');
      const card = widget.locator('.card', { hasText: `Ref. ${ref}` });
      // The shared test database holds other listings: find ours by its reference.
      await page.search({ q: ref });
      await card.waitFor({ timeout: 20_000 });
      expect(await card.innerText()).toMatch(/300,000/);
      expect(await status.innerText()).toMatch(/propert/);

      // A price ceiling below it excludes it (euros typed, cents sent), without the ceiling it is back.
      await page.search({ priceMax: '1' });
      expect(await status.innerText()).toMatch(/No properties/);
      await page.search({ priceMax: '' });
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

    const page = await newWatchedPage();
    try {
      await page.open(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      const card = widget.locator('.card', { hasText: `Ref. ${networkRef}` });
      await page.search({ q: networkRef });
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

    const page = await newWatchedPage();
    try {
      // The widget reports failures as a bubbling `inmolink:error` event; listen before the script runs.
      await page.addInitScript(() => {
        (window as unknown as { widgetErrors: string[] }).widgetErrors = [];
        document.addEventListener('inmolink:error', (e) =>
          (window as unknown as { widgetErrors: string[] }).widgetErrors.push((e as CustomEvent).detail.code),
        );
      });
      await page.open(other);
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

describe('JS widget lead form and AI box (S8-F8)', () => {
  it("[S8-F8] a widget enquiry arrives as a website lead with the site's agency", async () => {
    const page = await newWatchedPage();
    try {
      await page.addInitScript(() => {
        (window as unknown as { leads: unknown[] }).leads = [];
        document.addEventListener('inmolink:lead', (e) =>
          (window as unknown as { leads: unknown[] }).leads.push((e as CustomEvent).detail),
        );
      });
      await page.open(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      // Another agency's network listing: the lead still belongs to the site's (presenting) agency.
      const card = widget.locator('.card', { hasText: `Ref. ${networkRef}` });
      await page.search({ q: networkRef });
      await card.waitFor({ timeout: 20_000 });
      await card.locator('button').click();
      const dialog = widget.locator('[role=dialog]');
      const form = dialog.locator('form.lead');
      await form.waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => (window as unknown as { turnstileRendered?: unknown }).turnstileRendered);
      expect(
        await page.evaluate(() => (window as unknown as { turnstileRendered: unknown }).turnstileRendered),
      ).toEqual({ sitekey: TEST_SITE_KEY, action: 'website-lead', language: 'en' });
      // Viewing fields only for a viewing request; the privacy notice is linked.
      expect(await form.locator('input[name=date]').isVisible()).toBe(false);
      expect(await form.locator('a', { hasText: 'Privacy notice' }).getAttribute('href')).toBe(
        'https://www.widget-site.example/privacy',
      );
      const email = `visitor-${RUN}@example.com`;
      await form.locator('input[name=name]').fill('Ana Visitor');
      await form.locator('input[name=email]').fill(email);
      await form.locator('textarea[name=message]').fill('Is it still available?');
      await form.locator('input[name=privacy]').check();
      await form.locator('button[type=submit]').click();
      await dialog.locator('.sent').waitFor({ timeout: 20_000 });

      const rows = await adminQuery<{
        id: string;
        agency_id: string;
        owner_agency_id: string | null;
        site_id: string;
        kind: string;
        shown_ref: string;
        message: string;
      }>(
        'select id, agency_id, owner_agency_id, site_id, kind, shown_ref, message from website_leads where email = $1',
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agency_id: presentingId,
        owner_agency_id: ownerId,
        site_id: siteId,
        kind: 'ENQUIRY',
        shown_ref: networkRef,
        message: 'Is it still available?',
      });
      expect(await page.evaluate(() => (window as unknown as { leads: unknown[] }).leads)).toEqual([
        { id: rows[0]?.id, kind: 'ENQUIRY' },
      ]);
      // The Turnstile frame lived in the host's light DOM only while the form did.
      expect(await page.locator('[data-inmolink-widget] > [slot]').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('[S8-F8] an answer lost after the lead was stored: the resend with the same Idempotency-Key makes no second lead', async () => {
    const page = await newWatchedPage();
    try {
      await page.open(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      await page.search({ q: ref });
      await widget
        .locator('.card', { hasText: `Ref. ${ref}` })
        .locator('button')
        .click();
      const dialog = widget.locator('[role=dialog]');
      const form = dialog.locator('form.lead');
      await form.waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => (window as unknown as { turnstileRendered?: unknown }).turnstileRendered);
      const email = `retry-${RUN}@example.com`;
      await form.locator('input[name=name]').fill('Cy Retry');
      await form.locator('input[name=email]').fill(email);
      await form.locator('input[name=privacy]').check();

      // The first post reaches feed-api (the lead is stored), then the connection drops before the answer.
      const keys: string[] = [];
      let first = true;
      await page.route(`${apiOrigin}/v2/leads`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        keys.push(route.request().headers()['idempotency-key'] ?? '');
        if (!first) return route.continue();
        first = false;
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        return route.abort('connectionreset');
      });
      await form.locator('button[type=submit]').click();
      await form.locator('.error', { hasText: /could not be sent/ }).waitFor({ timeout: 20_000 });
      // The spent token is replaced at once; the button stays focusable (busy state, not disabled).
      expect(await page.evaluate(() => (window as unknown as { turnstileResets?: number }).turnstileResets)).toBe(1);
      expect(await form.locator('button[type=submit]').getAttribute('aria-disabled')).toBe('false');

      await form.locator('button[type=submit]').click();
      const sent = dialog.locator('.sent');
      await sent.waitFor({ timeout: 20_000 });
      // Focus stays in the dialog, on the confirmation.
      expect(await sent.evaluate((n) => (n.getRootNode() as ShadowRoot).activeElement === n)).toBe(true);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(await page.evaluate(() => (window as unknown as { turnstileResets?: number }).turnstileResets)).toBe(1);
      const rows = await adminQuery<{ count: string }>('select count(*) as count from website_leads where email = $1', [
        email,
      ]);
      expect(rows).toEqual([{ count: '1' }]);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('[S8-F8] a viewing request from the widget carries the chosen slot', async () => {
    const page = await newWatchedPage();
    try {
      await page.open(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      const card = widget.locator('.card', { hasText: `Ref. ${ref}` });
      await page.search({ q: ref });
      await card.waitFor({ timeout: 20_000 });
      await card.locator('button').click();
      const form = widget.locator('[role=dialog] form.lead');
      await form.waitFor({ timeout: 20_000 });
      const email = `viewer-${RUN}@example.com`;
      const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      await form.locator('select[name=kind]').selectOption('VIEWING');
      await form.locator('input[name=name]').fill('Bo Viewer');
      await form.locator('input[name=email]').fill(email);
      await form.locator('input[name=date]').fill(day);
      await form.locator('select[name=timeOfDay]').selectOption('MORNING');
      await form.locator('input[name=privacy]').check();
      await page.waitForFunction(() => (window as unknown as { turnstileRendered?: unknown }).turnstileRendered);
      await form.locator('button[type=submit]').click();
      await widget.locator('[role=dialog] .sent').waitFor({ timeout: 20_000 });
      const rows = await adminQuery<{ agency_id: string; kind: string; viewing_slots: unknown }>(
        'select agency_id, kind, viewing_slots from website_leads where email = $1',
        [email],
      );
      expect(rows).toEqual([
        { agency_id: presentingId, kind: 'VIEWING_REQUEST', viewing_slots: [{ date: day, timeOfDay: 'MORNING' }] },
      ]);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('[S13-F16] the widget searches by sentence on /v2/search/ai, next to the structured form', async () => {
    const page = await newWatchedPage();
    try {
      await page.open(allowed);
      const widget = page.locator('[data-inmolink-widget]');
      const search = widget.locator('form[role=search]');
      await search.waitFor({ timeout: 20_000 });
      // The structured form is unchanged: keyword box, sale/rent, price, bedrooms, sort.
      const names = await search
        .locator('input, select, textarea')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLInputElement).name));
      expect(names).toEqual(['q', 'transaction', 'priceMin', 'priceMax', 'bedsMin', 'sort']);

      const aiRequests: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/v2/search/ai')) aiRequests.push(r.url());
      });
      const card = widget.locator('.card', { hasText: `Ref. ${ref}` });
      await widget.locator('form.ai input[name=ai]').fill(ref);
      await widget.locator('form.ai button[type=submit]').click();
      await card.waitFor({ timeout: 20_000 });
      expect(aiRequests.length).toBeGreaterThan(0);
      expect(new URL(aiRequests[0] as string).searchParams.get('q')).toBe(ref);
    } finally {
      await page.close();
    }
  }, 120_000);
});
