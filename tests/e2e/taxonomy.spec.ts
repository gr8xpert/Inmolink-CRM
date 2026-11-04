import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEED_PASSWORD as password, seedStaff, seedUnmatched, TAXONOMY_IDS } from './seed';
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

/** A queue row of a value only this run has, above whatever earlier runs left. */
const queued = (page: Page, value: string) => page.getByTestId('unmatched-row').filter({ hasText: value });

test('[S17-F22] staff map, create and ignore queued feed values', async ({ page }) => {
  const suggested = `Feed Pool ${RUN}`;
  const chosen = `Feed Piscina ${RUN}`;
  const brandNew = `Feed Sauna ${RUN}`;
  const noise = `Feed Noise ${RUN}`;
  const place = `Feed Listland ${RUN}`;
  await seedUnmatched('feature', suggested, TAXONOMY_IDS.feature);
  await seedUnmatched('feature', chosen);
  await seedUnmatched('feature', brandNew);
  await seedUnmatched('feature', noise);
  await seedUnmatched('location', place, TAXONOMY_IDS.location);
  await login(page, await seedStaff('STAFF_DATA_OPS'));

  // The queue is reached from the import health page.
  await page.goto('/en/staff/imports');
  await page.getByRole('link', { name: 'Open the mapping queue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Feed values waiting for a mapping' })).toBeVisible();
  await page.getByRole('link', { name: 'Features', exact: true }).click();

  // A suggestion is preselected, and only the person's Map applies it.
  const first = queued(page, suggested);
  await expect(first).toContainText('Seen: 1,000,000');
  await expect(first.getByTestId('unmatched-target')).toContainText('E2E Outdoor › E2E Pool');
  await first.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByText(`“${suggested}” now maps to E2E Outdoor › E2E Pool`)).toBeVisible();
  await expect(first).toHaveCount(0);

  // No suggestion: nothing to map until a target is chosen from the filtered list. The other rows keep their state.
  const second = queued(page, chosen);
  await expect(second.getByRole('button', { name: 'Map', exact: true })).toBeDisabled();
  await second.getByRole('button', { name: 'Choose a target' }).click();
  await second.getByLabel('Type to filter').fill('e2e pool');
  await second.getByLabel('Target').selectOption({ label: 'E2E Outdoor › E2E Pool' });
  await queued(page, noise).getByRole('button', { name: 'Ignore' }).click();
  await expect(queued(page, noise)).toHaveCount(0);
  await expect(second.getByLabel('Type to filter')).toHaveValue('e2e pool');
  await second.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(second).toHaveCount(0);

  // A value nothing means yet: a new feature in the chosen group, mapped at once.
  const third = queued(page, brandNew);
  await third.getByRole('button', { name: 'Create new and map' }).click();
  await third.getByLabel('Group').selectOption({ label: 'E2E Outdoor' });
  await third.getByRole('button', { name: 'Create and map' }).click();
  await expect(third).toHaveCount(0);

  // A location's suggestion shows its path before it can be mapped; there is no create on this tab.
  await page.getByRole('link', { name: 'Locations', exact: true }).click();
  const fourth = queued(page, place);
  await expect(fourth.getByRole('button', { name: 'Create new and map' })).toHaveCount(0);
  await expect(fourth.getByRole('button', { name: 'Map', exact: true })).toBeDisabled();
  await fourth.getByRole('button', { name: 'Check the suggestion' }).click();
  await expect(fourth.getByTestId('unmatched-target')).toContainText('E2E Listland (Country)');
  await fourth.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(fourth).toHaveCount(0);

  // All of it stuck: a fresh read of the queue no longer has them.
  await page.goto('/en/staff/taxonomy/unmatched?kind=feature');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  for (const value of [suggested, chosen, brandNew, noise]) await expect(queued(page, value)).toHaveCount(0);
});

test('[S17-F22] support staff see the queue read-only', async ({ page }) => {
  const value = `Feed Look ${RUN}`;
  await seedUnmatched('feature', value, TAXONOMY_IDS.feature);
  await login(page, await seedStaff('STAFF_SUPPORT'));
  await page.goto('/en/staff/taxonomy/unmatched?kind=feature');
  await expect(page.getByText(/You can look but not change/)).toBeVisible();
  const row = queued(page, value);
  await expect(row).toContainText('Suggested: E2E Pool');
  await expect(row.getByRole('button')).toHaveCount(0);
});
