import { expect, type Page, test } from '@playwright/test';
import { SEED_PASSWORD as password, seedStaff } from './seed';
import { passTwoFactor } from './two-factor';

/** Staff taxonomy editor in the browser (S2-04): create an area, draw its polygon, translate it, add an alias. */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.request.get('/en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, password);
}

const RUN = Date.now().toString(36);

/** The row of an item, by its exact name. */
const row = (page: Page, name: string) =>
  page
    .locator('li')
    .filter({ has: page.getByRole('button', { name, exact: true }) })
    .first();

async function create(page: Page, opener: ReturnType<Page['getByRole']>, name: string): Promise<void> {
  await opener.click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText(name);
}

test('[S2-04] staff create an area, draw its polygon, translate it and map an alias', async ({ page }) => {
  // The map needs a style but not tiles: an empty one keeps the test off the network.
  await page.route('**/demotiles.maplibre.org/style.json', (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde' } }],
      },
    }),
  );
  const workerErrors: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Worker failed to load')) workerErrors.push(m.text());
  });
  const ops = await seedStaff('STAFF_DATA_OPS');
  await login(page, ops);
  await page.goto('/en/staff/taxonomy');
  await expect(page.getByRole('heading', { level: 1, name: 'Taxonomy' })).toBeVisible();

  const country = `Spainland ${RUN}`;
  const region = `Southland ${RUN}`;
  const city = `Seaport ${RUN}`;
  const area = `Golden Mile ${RUN}`;
  await create(page, page.getByRole('button', { name: 'Add a country' }), country);
  await create(page, row(page, country).getByRole('button', { name: /^Add region/ }), region);
  await create(page, row(page, region).getByRole('button', { name: /^Add city/ }), city);
  await create(page, row(page, city).getByRole('button', { name: /^Add area/ }), area);

  // Draw a polygon: click corners, click the last one again to finish, then save.
  const map = page.getByTestId('polygon-map');
  await expect(map.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Draw area' }).click();
  const box = (await map.boundingBox()) as { x: number; y: number; width: number; height: number };
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  for (const p of [at(0.3, 0.3), at(0.7, 0.3), at(0.7, 0.7), at(0.7, 0.7)]) {
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByText('No area drawn yet.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save area' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');

  // Created in the default content locale (es); add English, and map a feed spelling.
  await page.getByLabel('Add language').selectOption('en');
  await page.locator('#name-en').fill(`Golden Mile EN ${RUN}`);
  await page.getByRole('button', { name: 'Save translations' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await page.getByLabel('Feed aliases').fill(`Milla Oro ${RUN}`);
  await page.getByRole('button', { name: 'Add alias' }).click();
  await expect(page.getByText(`Milla Oro ${RUN}`)).toBeVisible();

  // Everything persisted: reopen the area after a reload.
  await page.reload();
  // Expanders read "▸ Region (1)": open the path down to the area.
  await row(page, country).getByRole('button', { name: 'Region (1)' }).click();
  await row(page, region).getByRole('button', { name: 'City (1)' }).click();
  await row(page, city).getByRole('button', { name: 'Area (1)' }).click();
  // The editor shows names in the staff locale (en): the English name added above.
  const areaEn = `Golden Mile EN ${RUN}`;
  await row(page, areaEn).getByRole('button', { name: areaEn, exact: true }).click();
  await expect(page.locator('#name-en')).toHaveValue(`Golden Mile EN ${RUN}`);
  await expect(page.getByText(`Milla Oro ${RUN}`)).toBeVisible();
  await expect(page.getByText('No area drawn yet.')).toHaveCount(0);
  // MapLibre's worker loaded (public/maplibre): without it no vector tiles render.
  expect(workerErrors).toEqual([]);
});

test('[S2-04] support staff see the taxonomy read-only', async ({ page }) => {
  const support = await seedStaff('STAFF_SUPPORT');
  await login(page, support);
  await page.goto('/en/staff/taxonomy');
  await expect(page.getByText(/You can look but not change/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a country' })).toHaveCount(0);
});
