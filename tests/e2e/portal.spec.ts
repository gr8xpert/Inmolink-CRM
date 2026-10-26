import { randomInt } from 'node:crypto';
import type { APIRequestContext, Browser } from '@playwright/test';
import { expect, test } from './fixtures';
import { LISTING_TAXONOMY, SEED_PASSWORD as password, seedListingAgent, TAXONOMY_IDS } from './seed';
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
