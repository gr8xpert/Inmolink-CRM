import { randomBytes } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { consentState } from './consent';
import { expect, test } from './fixtures';
import { LISTING_TAXONOMY, SEED_PASSWORD as password, seedDeveloperAdmin, seedListingAgent } from './seed';
import { testStackEnv } from './stack';
import { passTwoFactor } from './two-factor';

/**
 * R2-07a acceptance (E2E): a developer uploads a development (its units from a Kyero file), restricts it to three
 * agencies found by name in the directory, and only those agencies find it in network search — a fourth verified
 * agency does not, and cannot open it. The units reach the search index through the worker (outbox → read models →
 * index), so the three searches wait for them; the fourth searches only after they are indexed.
 */

const WEB_URL = testStackEnv().WEB_URL as string;

async function login(page: Page, email: string, twoFactor = false): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  if (twoFactor) await passTwoFactor(page, email, password);
  else await expect(page).toHaveURL(/\/en$/);
}

/** An agent of a verified agency, signed in in a browser context of its own. */
async function agency(browser: Browser): Promise<{ company: string; page: Page }> {
  const seeded = await seedListingAgent();
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'en-GB', storageState: consentState(WEB_URL) });
  const page = await context.newPage();
  await login(page, seeded.email);
  return { company: seeded.company, page };
}

const kyero = (tag: string) => ({
  name: 'units.xml',
  mimeType: 'application/xml',
  buffer: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<root><kyero><feed_version>3</feed_version></kyero>${[1, 2, 3]
      .map(
        (n) =>
          `<property><id>K${tag}-${n}</id><type>${LISTING_TAXONOMY.propertyType}</type><price>${300_000 + n * 1_000}</price>` +
          `<beds>${n}</beds><baths>2</baths><surface_area><built>${80 + n}</built></surface_area></property>`,
      )
      .join('')}</root>\n`,
  ),
});

test('[R2-07] developer uploads a development, restricts it to 3 agencies, and only those agencies can find it', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const name = `Mirador ${tag}`;
  const developer = await seedDeveloperAdmin();
  const [a, b, c, outsider] = [
    await agency(browser),
    await agency(browser),
    await agency(browser),
    await agency(browser),
  ];

  // The developer creates the development and uploads its units from a Kyero file.
  await login(page, developer.email, true);
  await page.goto('/en/developments/new');
  await page.getByLabel('Reference').fill(`DEV-${tag}`);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Location').selectOption({ label: LISTING_TAXONOMY.location });
  await page.getByRole('button', { name: 'Create development' }).click();
  await expect(page).toHaveURL(/\/en\/developments\/[0-9a-f-]{36}$/);
  const devUrl = new URL(page.url()).pathname;

  await page.getByLabel('Units Kyero XML file').setInputFiles(kyero(tag));
  await expect(page.getByText('3 units ready to import from the Kyero file.')).toBeVisible();
  await page.getByRole('button', { name: 'Import units from Kyero' }).click();
  await expect(page.getByText('3 units imported.')).toBeVisible();
  await expect(page.getByTestId('units-table').locator('tbody tr')).toHaveCount(3);

  // Restricted to three agencies, found by name in the directory (none of them is a preferred agency).
  const sharing = page.locator('section', { has: page.getByRole('heading', { name: 'Sharing' }) });
  await expect(sharing.getByLabel('Named agencies only')).toBeChecked();
  for (const who of [a, b, c]) {
    await sharing.getByLabel('Find a verified agency by name').fill(who.company);
    await sharing.getByRole('button', { name: 'Search' }).click();
    // Ticking moves the agency from the results to the named list (so `click`, not `check`, which re-reads it).
    await sharing.getByLabel(`Add ${who.company}`).click();
    await expect(sharing.getByLabel(who.company, { exact: true })).toBeChecked();
  }
  await sharing.getByRole('button', { name: 'Save sharing' }).click();
  await expect(sharing.getByText('Sharing saved.')).toBeVisible();
  // Saved, not only shown: after a reload the three are listed by name.
  await page.reload();
  for (const who of [a, b, c]) await expect(sharing.getByLabel(who.company, { exact: true })).toBeChecked();
  await expect(sharing.getByLabel(outsider.company, { exact: true })).toHaveCount(0);

  // Each of the three finds the three units in network search (once the worker has indexed them).
  const search = `/en/network?${new URLSearchParams({ q: name, newBuilds: '1' })}`;
  const results = (p: Page) => p.getByRole('link', { name, exact: true });
  for (const who of [a, b, c]) {
    await expect
      .poll(
        async () => {
          await who.page.goto(search);
          return results(who.page).count();
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(3);
  }

  // The fourth agency, searching after the units are indexed, finds nothing and cannot open the development.
  await outsider.page.goto(search);
  await expect(outsider.page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(results(outsider.page)).toHaveCount(0);
  // The same "Page not found" as an unknown id (streamed pages answer 200, so the page is checked, not the status).
  await outsider.page.goto(devUrl);
  await expect(outsider.page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

  for (const who of [a, b, c, outsider]) await who.page.context().close();
});
