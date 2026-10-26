import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEED_PASSWORD as password, seedListingAgent } from './seed';

/** Development UI in the browser (S4-03): create, 48 units from a CSV, 3 reserved in bulk, a price list's diff. */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
}

const ref = (n: number) => `U-${String(n).padStart(2, '0')}`;
const csvFile = (name: string, lines: string[]) => ({
  name,
  mimeType: 'text/csv',
  buffer: Buffer.from(`${lines.join('\n')}\n`),
});

test('[S4-03] create development → add 48 units via CSV → mark 3 reserved → diff view shows changes', async ({
  page,
}) => {
  const seeded = await seedListingAgent();
  const tag = randomBytes(3).toString('hex').toUpperCase();
  await login(page, seeded.email);

  // The navigation leads to the agency's developments; a new one starts with reference, name and place.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Developments' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Developments' })).toBeVisible();
  await page.getByRole('link', { name: 'New development' }).click();
  await expect(page).toHaveURL(/\/en\/developments\/new$/);
  await page.getByLabel('Reference').fill(`DEV-${tag}`);
  await page.getByLabel('Name').fill(`Mirador ${tag}`);
  await page.getByLabel('Location').selectOption({ label: seeded.location });
  await page.getByRole('button', { name: 'Create development' }).click();
  await expect(page).toHaveURL(/\/en\/developments\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Development DEV-${tag}`);
  await expect(page.getByText('No units yet. Import a CSV to add them.')).toBeVisible();

  // 48 units from a semicolon CSV (as Spanish Excel writes it), the type by its name.
  const units = Array.from(
    { length: 48 },
    (_, i) => `${ref(i + 1)};${seeded.propertyType};${(i % 3) + 1};${i % 12};${250_000 + i * 1_000}`,
  );
  await page
    .getByLabel('Units CSV file')
    .setInputFiles(csvFile('units.csv', ['ref;type;bedrooms;floor;price', ...units]));
  await expect(page.getByText('48 units ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import units' }).click();
  await expect(page.getByText('48 units imported.')).toBeVisible();
  const table = page.getByTestId('units-table');
  await expect(table.locator('tbody tr')).toHaveCount(48);

  // Three units reserved in one bulk change.
  for (const n of [1, 2, 3]) await page.getByLabel(`Select unit ${ref(n)}`).check();
  await expect(page.getByTestId('units-selected')).toHaveText('3 selected');
  await page.getByLabel('Mark selected as').selectOption({ label: 'Reserved' });
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('3 units updated.')).toBeVisible();
  for (const n of [1, 2, 3]) await expect(page.getByLabel(`Status of unit ${ref(n)}`)).toHaveValue('RESERVED');
  await expect(page.getByLabel(`Status of unit ${ref(4)}`)).toHaveValue('AVAILABLE');

  // Still reserved after a reload (saved, not only shown); the filter lists exactly those three.
  await page.reload();
  await page.getByLabel('Show').selectOption({ label: 'Reserved' });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await page.getByLabel('Show').selectOption({ label: 'All units' });
  await expect(table.locator('tbody tr')).toHaveCount(48);

  // The developer's new price list: two prices up, one reserved unit sold, one new reference, one missing.
  const lines = Array.from({ length: 47 }, (_, i) => {
    const n = i + 1;
    const price = n === 4 ? 265_000 : n === 5 ? 270_500 : 250_000 + i * 1_000;
    return `${ref(n)},${price},${n === 2 ? 'SOLD' : ''}`;
  });
  await page
    .getByLabel('Price list CSV file')
    .setInputFiles(csvFile('prices.csv', ['ref,price,status', ...lines, 'U-49,300000,']));
  await expect(page.getByText('48 lines ready to upload.')).toBeVisible();
  await page.getByRole('button', { name: 'Upload price list' }).click();
  await expect(page.getByText('Version 1 uploaded.')).toBeVisible();

  const diff = page.getByTestId('price-list-diff');
  await expect(diff.getByRole('heading', { name: 'Changes in version 1' })).toBeVisible();
  await expect(diff.getByText('44 unchanged')).toBeVisible();
  await expect(diff.getByText('Changed (3)')).toBeVisible();
  const changed = diff.getByTestId('diff-changed');
  await expect(changed.getByRole('row', { name: /U-02/ })).toContainText('Reserved → Sold');
  await expect(changed.getByRole('row', { name: /U-04/ })).toContainText(/253,000\.00 → €265,000\.00/);
  await expect(changed.getByRole('row', { name: /U-05/ })).toContainText(/254,000\.00 → €270,500\.00/);
  await expect(diff.getByTestId('diff-added')).toHaveText(/U-49/);
  await expect(diff.getByTestId('diff-removed')).toHaveText(/U-48/);
  await expect(page.getByText('Waiting for approval')).toBeVisible();
});
