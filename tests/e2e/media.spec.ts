import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { SEED_PASSWORD as password, seedListingAgent } from './seed';

/** Media manager in the browser (S3-06): mass upload with progress, instant duplicate skip, reorder that persists. */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
}

/** A small JPEG-looking file unique to this run (the API checks magic bytes; no media worker runs here). */
function photo(run: string, n: number) {
  const buffer = Buffer.alloc(4_096, n);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  buffer.write(`${run}:${n}`, 8);
  return { name: `photo-${String(n).padStart(2, '0')}.jpg`, mimeType: 'image/jpeg', buffer };
}

const order = (page: Page) =>
  page
    .getByTestId('media-item')
    // The root tsconfig has no DOM lib: read the attribute through the dataset's shape.
    .evaluateAll((els) => els.map((el) => (el as unknown as { dataset: { mediaId?: string } }).dataset.mediaId ?? ''));

test('[S3-06] 50 photos upload with progress; duplicates are skipped instantly; order persists', async ({ page }) => {
  await page.route('**/demotiles.maplibre.org/style.json', (route) =>
    route.fulfill({ json: { version: 8, sources: {}, layers: [] } }),
  );
  const seeded = await seedListingAgent();
  await login(page, seeded.email);
  await page.goto('/en/listings/new');
  await page.getByLabel('Property type').selectOption({ label: seeded.propertyType });
  await page.getByLabel('Location').selectOption({ label: seeded.location });
  await page.getByRole('button', { name: 'Create listing' }).click();
  await expect(page).toHaveURL(/\/en\/listings\/[0-9a-f-]{36}$/);
  const editorUrl = page.url();

  // Uploads go from the browser straight to storage: count the signed PUTs.
  let puts = 0;
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/originals/')) puts++;
  });

  const run = randomUUID();
  const files = Array.from({ length: 50 }, (_, n) => photo(run, n));
  const input = page.getByLabel('Photos to upload');
  await input.setInputFiles(files);
  await expect(page.getByTestId('media-progress')).toHaveText(/Uploaded \d+ of 50/);
  await expect(page.getByTestId('media-summary')).toHaveText('50 uploaded · 0 skipped · 0 failed', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('media-progress')).toHaveText('Uploaded 50 of 50');
  await expect(page.getByTestId('media-item')).toHaveCount(50);
  await expect(page.getByTestId('media-error')).toHaveCount(0);
  expect(puts).toBe(50);
  // The first photo became the cover.
  await expect(page.getByTestId('media-item').first().getByTestId('media-cover')).toBeVisible();

  // The same 50 again: skipped without a request to storage, at once.
  const started = Date.now();
  await input.setInputFiles(files);
  await expect(page.getByTestId('media-summary')).toHaveText('0 uploaded · 50 skipped · 0 failed', {
    timeout: 10_000,
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(puts).toBe(50);
  await expect(page.getByTestId('media-item')).toHaveCount(50);

  // Reorder: drag the first file onto the third, then move the last one earlier with its arrow.
  const before = await order(page);
  const status = page.getByTestId('media-save-status');
  /** Every change sent was answered and saved. */
  const settled = async () => {
    await expect(status).toHaveAttribute('data-pending', '0');
    await expect(status).toHaveText('Saved');
  };
  await page.getByTestId('media-item').nth(0).dragTo(page.getByTestId('media-item').nth(2));
  await settled();
  await page.getByRole('button', { name: 'Move earlier: File 50' }).click();
  await settled();
  const [b0, b1, b2, ...rest] = before;
  const last = rest.pop() as string;
  const expected = [b1, b2, b0, ...rest.slice(0, -1), last, rest.at(-1)];
  await expect.poll(() => order(page)).toEqual(expected);

  // Cover, kind, room and alt text on one file.
  const card = page.getByTestId('media-item').nth(3);
  await card.getByRole('button', { name: 'Make cover: File 4' }).click();
  await expect(card.getByTestId('media-cover')).toBeVisible();
  await card.getByLabel('Room').selectOption('POOL');
  await settled();
  await card.getByLabel('Alt text').fill('Pool with sea views');
  await card.getByLabel('Alt text').blur();
  await settled();
  await page.getByTestId('media-item').nth(4).getByLabel('Kind').selectOption('FLOOR_PLAN');
  await settled();
  await expect(page.getByTestId('media-error')).toHaveCount(0);

  // Everything persisted.
  await page.goto(editorUrl);
  await expect.poll(() => order(page)).toEqual(expected);
  const reloaded = page.getByTestId('media-item').nth(3);
  await expect(reloaded.getByTestId('media-cover')).toBeVisible();
  await expect(page.getByTestId('media-cover')).toHaveCount(1);
  await expect(reloaded.getByLabel('Room')).toHaveValue('POOL');
  await expect(reloaded.getByLabel('Alt text')).toHaveValue('Pool with sea views');
  await expect(page.getByTestId('media-item').nth(4).getByLabel('Kind')).toHaveValue('FLOOR_PLAN');
});
