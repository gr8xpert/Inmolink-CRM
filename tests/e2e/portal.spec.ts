import { randomInt } from 'node:crypto';
import type { APIRequestContext, Browser } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  LISTING_TAXONOMY,
  SEED_PASSWORD as password,
  seedLegacyRedirect,
  seedListingAgent,
  TAXONOMY_IDS,
} from './seed';
import { PUBLIC_URL, testStackEnv } from './stack';

/**
 * The public portal (S15-01, inmolink.es) on the real stack: an agent publishes a listing through the api, the
 * worker builds its read model, and a visitor finds it on the location page with a filter, opens it, and sees the
 * listing agency — never its commission or internal notes. Search and location pages are CDN-cacheable.
 */

const env = testStackEnv();
const API_URL = env.API_URL as string;
const WEB_URL = env.WEB_URL as string;

/** A verified agency's agent, signed in on the dashboard; its api token comes from the web session. */
async function agent(browser: Browser) {
  const seeded = await seedListingAgent();
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(seeded.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
  const minted = await page.request.get('/session/token?aud=api');
  expect(minted.status()).toBe(200);
  const { token } = (await minted.json()) as { token: string };
  await context.close();
  return { ...seeded, token };
}

async function publish(request: APIRequestContext, token: string, priceCents: number): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  const ok = async <T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> => {
    expect(res.status(), `${res.url()} answered ${res.status()}: ${await res.text()}`).toBe(status);
    return (await res.json()) as T;
  };
  const created = await ok<{ id: string; version: number }>(
    await request.post(`${API_URL}/v1/listings`, {
      headers,
      data: { propertyTypeId: TAXONOMY_IDS.type, locationId: TAXONOMY_IDS.location },
    }),
    201,
  );
  const translated = await ok<{ version: number }>(
    await request.put(`${API_URL}/v1/listings/${created.id}/translations/en`, {
      headers,
      data: { version: created.version, title: 'Sunny villa', description: 'A bright villa with a pool and views.' },
    }),
    200,
  );
  await ok(
    await request.patch(`${API_URL}/v1/listings/${created.id}`, {
      headers,
      data: {
        version: translated.version,
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        shareScope: 'ALL',
        energyRating: 'B',
        priceCents,
        bedrooms: 3,
        commission: { type: 'PCT', basisPoints: 300, includesVat: false },
        internalNotes: 'Owner wants a quick sale — do not tell buyers',
      },
    }),
    200,
  );
  return created.id;
}

test('[S15-01] portal: a visitor finds a new listing on its location page with a filter, opens it and sees the listing agency', async ({
  browser,
  request,
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const seller = await agent(browser);
  // A price no other run's listing has: the price filter finds this one listing.
  const euros = 300_000 + randomInt(1, 9_999_999);
  await publish(request, seller.token, euros * 100);

  const location = `${PUBLIC_URL}/en/properties/e2e-listland`;
  const filtered = `${location}?price_min=${euros}&price_max=${euros}`;
  const title = `${LISTING_TAXONOMY.propertyType} in ${LISTING_TAXONOMY.location}`;
  // The worker builds the read model (outbox): until then the location page does not list it.
  await expect
    .poll(
      async () => {
        await page.goto(filtered);
        return page.getByRole('link', { name: title }).count();
      },
      // The read model (worker) and the portal's listed-agency set (refreshed each minute) must both see the listing.
      { timeout: 150_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(1);

  // The location page: live count in the heading, crawlable and CDN-cacheable.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`for sale in ${LISTING_TAXONOMY.location}`);
  const head = await request.get(location);
  expect(head.status()).toBe(200);
  expect(head.headers()['cache-control']).toMatch(/public.*s-maxage=\d+/);
  expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toContain('/en/properties/e2e-listland');
  // Filtered searches are not indexed (the location page and its numbered pages are).
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toMatch(/noindex/);

  // The card names the listing agency (no link until its profile pages exist, S15-03) and opens the listing page.
  await expect(page.getByText(seller.company)).toBeVisible();
  await expect(page.getByRole('link', { name: seller.company })).toHaveCount(0);
  await page.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/\/en\/property\/e2e-villa-in-e2e-listland-[0-9a-z]{8}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(
    page
      .getByText(
        new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(euros),
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText(seller.company).first()).toBeVisible();
  expect(await page.locator('a[href*="/agency/"]').count()).toBe(0);
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.map((s) => JSON.parse(s)['@type'])).toEqual(
    expect.arrayContaining(['RealEstateListing', 'BreadcrumbList']),
  );
  expect(await page.locator('link[rel="alternate"][hreflang="es"]').getAttribute('href')).toMatch(/\/es\/property\//);
  const html = await page.content();
  // White-label for buyers: no commission, no internal notes.
  expect(html).not.toContain('quick sale');
  expect(html).not.toMatch(/commission/i);

  // The same listing in Spanish (its own localized URL).
  const es = await request.get(page.url().replace('/en/', '/es/'));
  expect(es.status()).toBeLessThan(500);
});

/** Cloudflare Turnstile, solved at once (the e2e stack checks tokens with its own siteverify stub). */
const TURNSTILE_STUB = `window.turnstile = { reset() {} };
for (const el of document.querySelectorAll('.cf-turnstile')) {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'cf-turnstile-response';
  input.value = 'e2e-pass-' + Math.random().toString(36).slice(2);
  el.appendChild(input);
}`;

test('[S15-02] portal: an enquiry reaches the listing agency as a MARKETPLACE lead; a legacy URL answers 301', async ({
  browser,
  request,
  page,
}) => {
  test.setTimeout(6 * 60_000);
  const seller = await agent(browser);
  const euros = 300_000 + randomInt(1, 9_999_999);
  await publish(request, seller.token, euros * 100);
  const title = `${LISTING_TAXONOMY.propertyType} in ${LISTING_TAXONOMY.location}`;
  await expect
    .poll(
      async () => {
        await page.goto(`${PUBLIC_URL}/en/properties/e2e-listland?price_min=${euros}&price_max=${euros}`);
        return page.getByRole('link', { name: title }).count();
      },
      { timeout: 150_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(1);
  await page.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/\/en\/property\/e2e-villa-in-e2e-listland-[0-9a-z]{8}$/);
  const listingPath = new URL(page.url()).pathname;

  // A URL of the old inmolink.es (another shape, another case, a tracking parameter) moves for good to the new page.
  const tag = randomInt(1, 1_000_000_000).toString(36);
  // A name with letters only (the lead contract refuses digits in names).
  const who = `Jane ${tag.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] as string)}`;
  await seedLegacyRedirect(`/property-details/e2e-${tag}/villa-in-listland`, listingPath);
  const moved = await request.get(`${PUBLIC_URL}/property-details/E2E-${tag}/Villa-in-Listland?utm_source=old`, {
    maxRedirects: 0,
  });
  expect(moved.status()).toBe(301);
  // Same origin: Next writes the Location as a path.
  expect(new URL(moved.headers().location as string, PUBLIC_URL).href).toBe(`${PUBLIC_URL}${listingPath}`);
  // An old URL nobody mapped is not redirected anywhere off the portal (locale routing, then the 404 page).
  const unknown = await request.get(`${PUBLIC_URL}/property-details/none-${tag}/x`, { maxRedirects: 0 });
  expect(unknown.status()).not.toBe(301);

  // The enquiry form: Turnstile loads on first use (stubbed), the answer shows in place.
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB }),
  );
  const form = page.getByTestId('portal-enquiry');
  await form.getByLabel('Your name').fill(who);
  await expect(form.locator('input[name="cf-turnstile-response"]')).toHaveCount(1);
  await form.getByLabel('Email', { exact: true }).fill(`jane-${tag}@example.com`);
  await form.getByLabel(/I agree that/).check();
  await form.getByRole('button', { name: 'Send enquiry' }).click();
  await expect(form.getByRole('status')).toContainText(`sent to ${seller.company}`);

  // The listing agency sees it in its inbox as a marketplace lead (promoted by the worker from the outbox).
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB' });
  const dashboard = await context.newPage();
  await dashboard.goto('/login');
  await dashboard.getByLabel('Email').fill(seller.email);
  await dashboard.getByLabel('Password').fill(password);
  await dashboard.getByRole('button', { name: 'Log in' }).click();
  await expect(dashboard).toHaveURL(/\/en$/);
  await expect
    .poll(
      async () => {
        await dashboard.goto('/en/inbox?source=MARKETPLACE');
        return dashboard.getByText(who).count();
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(0);
  await expect(dashboard.getByTestId('lead-list').getByRole('listitem').filter({ hasText: who })).toContainText(
    'Marketplace',
  );
  await context.close();
});
