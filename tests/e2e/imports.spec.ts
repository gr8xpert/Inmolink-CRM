import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEED_PASSWORD as password, seedImportAdmin } from './seed';
import { PORTS, ROOT } from './stack';
import { passTwoFactor } from './two-factor';

/**
 * The generic XML connector and the visual mapper in the browser (S6-04): an agency admin maps a non-Kyero feed to a
 * profile — upload a sample, pick the fields, preview, dry run, save — connects the feed with that profile and
 * imports it, with no code written for the format. The feed is served by the e2e feed host on loopback (the api and
 * the worker may fetch that origin only: `tests/e2e/loopback-feeds.ts`); the import runs in the worker's imports pool.
 */

const FIXTURE = join(ROOT, 'tests', 'fixtures', 'xml-mapped', 'estate-export.xml');
const FEED_URL = `http://127.0.0.1:${PORTS.feed}/estate.xml`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, password);
}

/** The picker of a field, by its label ("Price" must not match "Price period"; required fields carry a star). */
const field = (page: Page, label: string) => page.getByLabel(new RegExp(`^${label}( \\*)?$`));

test('[S6-04] map a non-Kyero feed to a profile in the mapper and import it without code changes', async ({ page }) => {
  test.setTimeout(240_000);
  const admin = await seedImportAdmin();
  await login(page, admin.email);

  // 1. A sample: the uploaded file is read, the repeating record element found.
  await page.goto('/en/imports/mapper');
  await expect(page.getByRole('heading', { level: 1, name: 'Map a feed or a spreadsheet' })).toBeVisible();
  await page.getByLabel('XML, CSV or Excel file').setInputFiles(FIXTURE);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByTestId('sample-summary')).toContainText('The feed repeats the element object; 4 of them');

  // 2. The field pickers start from the guesses and show the values found at the chosen path.
  await expect(field(page, 'Reference')).toHaveValue('@code');
  await expect(page.getByTestId('values-ref')).toContainText('CD-1001');
  await expect(field(page, 'Property type')).toHaveValue('category');
  await expect(field(page, 'Price')).toHaveValue('price');

  // What the guesses cannot know: the deal words, the country, the number format, the texts per language.
  await field(page, 'Numbers are written with').selectOption('comma');
  await field(page, 'Sale or rental').selectOption('deal');
  await page
    .getByLabel(/^Translate the words of the feed into ours \(SALE, RENT_LONG_TERM/)
    .first()
    .fill('venta = SALE\nalquiler = RENT_LONG_TERM');
  await field(page, 'Country').selectOption('place/nation');
  await page.getByLabel('Title', { exact: true }).first().selectOption('title_en');
  await page.getByLabel('Description', { exact: true }).first().selectOption('body_en');
  await page.getByRole('button', { name: 'Add a language' }).click();
  await page.getByRole('combobox', { name: 'Language' }).nth(1).selectOption('es');
  await page.getByLabel('Title', { exact: true }).nth(1).selectOption('title_es');
  await page.getByLabel('Description', { exact: true }).nth(1).selectOption('body_es');

  // 3. The preview shows the listings the mapping makes: valid ones and the one it refuses.
  const preview = page.getByTestId('mapper-preview');
  await expect(preview.getByRole('row', { name: /CD-1001/ })).toContainText('1,250,000.00 EUR');
  await expect(preview.getByRole('row', { name: /CD-1002/ })).toContainText('RENT_LONG_TERM');
  await expect(preview.getByRole('row', { name: /CD-1003/ })).toContainText('INVALID_PRICE');

  // 4. The dry run says what an import would do and writes nothing.
  await page.getByRole('button', { name: 'Run a dry run' }).click();
  const report = page.getByTestId('dry-run-report');
  await expect(report).toContainText('4 listings read: 3 would be created, 0 updated, 3 held as drafts, 1 refused.');
  await expect(report).toContainText('CD-1003: INVALID_PRICE');
  await expect(report).toContainText('Seaside');

  // 5. Save the profile; the connection form opens with it chosen.
  const profileName = `Casa Datos ${Date.now().toString(36)}`;
  await page.getByLabel('Name of the mapping profile').fill(profileName);
  await page.getByRole('button', { name: 'Save the profile' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Connect a feed' })).toBeVisible();
  await expect(page.getByLabel('Format')).toHaveValue('xml-mapped');
  await expect(page.getByLabel('Mapping profile')).toContainText(profileName);
  await page.getByLabel('Name', { exact: true }).fill('Casa Datos export');
  await page.getByLabel('Feed address (URL)').fill(FEED_URL);
  await page.getByLabel('Import', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Connect feed' }).click();
  await expect(page.getByText('The feed was connected')).toBeVisible();

  // 6. Run it: the worker fetches the feed, maps it by the profile and loads it.
  const connection = page.getByRole('row', { name: /Casa Datos export/ });
  await expect(connection).toContainText('xml-mapped');
  await connection.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText('The run was queued')).toBeVisible();
  await connection.getByRole('link', { name: 'Casa Datos export' }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  const runs = page.getByTestId('feed-runs');
  await expect(async () => {
    await page.reload();
    await expect(runs.getByRole('row').nth(1)).toContainText('Done');
  }).toPass({ timeout: 90_000, intervals: [2_000] });
  // read 4, valid 3, refused 1, new 3 (the towns are not in the taxonomy yet: the drafts wait for staff to map them)
  const cells = await runs.getByRole('row').nth(1).getByRole('cell').allInnerTexts();
  expect(cells.slice(4, 12)).toEqual(['4', '3', '1', '3', '0', '0', '3', '0']);

  // 7. The refused item is listed with its problem.
  await page.getByRole('link', { name: 'Show refused items' }).click();
  await expect(page.getByRole('row', { name: /CD-1003/ })).toContainText('INVALID_PRICE');
});

test('[S6-05] import a CSV file through the mapper: upload, map columns, import, per-row errors', async ({ page }) => {
  test.setTimeout(240_000);
  const admin = await seedImportAdmin();
  await login(page, admin.email);

  await page.goto('/en/imports/mapper');
  const csv = [
    'Ref;Type;Price;Country',
    'CSV-1;E2E Villa;250000;E2E Listland',
    'CSV-2;E2E Villa;abc;E2E Listland',
    'CSV-3;E2E Villa;=1+1;E2E Listland',
  ].join('\r\n');
  await page
    .getByLabel('XML, CSV or Excel file')
    .setInputFiles({ name: 'listings.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByTestId('sample-summary')).toContainText(
    'The file has 4 columns with values; the first 3 rows',
  );

  // The columns are the paths; the guesses start from their names.
  await expect(field(page, 'Reference')).toHaveValue('Ref');
  await expect(field(page, 'Property type')).toHaveValue('Type');
  await expect(field(page, 'Price')).toHaveValue('Price');
  await field(page, 'Country').selectOption('Country');
  const preview = page.getByTestId('mapper-preview');
  await expect(preview.getByRole('row', { name: /CSV-1/ })).toContainText('250,000.00');
  await expect(preview.getByRole('row', { name: /CSV-2/ })).toContainText('INVALID_PRICE');

  await page.getByRole('button', { name: 'Run a dry run' }).click();
  await expect(page.getByTestId('dry-run-report')).toContainText('3 listings read: 1 would be created');

  // Import: the file gets a connection and a run in the worker.
  await page.getByLabel('Name of the mapping profile').fill(`CSV listings ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'Import the file' }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  const runs = page.getByTestId('feed-runs');
  await expect(async () => {
    await page.reload();
    await expect(runs.getByRole('row').nth(1)).toContainText('Done');
  }).toPass({ timeout: 90_000, intervals: [2_000] });
  // read 3, valid 1, refused 2 (a text price, and a price that starts with "=": data, not a formula), new 1
  const cells = await runs.getByRole('row').nth(1).getByRole('cell').allInnerTexts();
  expect(cells.slice(4, 12)).toEqual(['3', '1', '2', '1', '0', '0', '0', '0']);
  await page.getByRole('link', { name: 'Show refused items' }).click();
  await expect(page.getByRole('row', { name: /CSV-2/ })).toContainText('INVALID_PRICE');
  await expect(page.getByRole('row', { name: /CSV-3/ })).toContainText('INVALID_PRICE');
});
