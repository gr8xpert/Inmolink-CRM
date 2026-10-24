import { expect, type Page, test } from '@playwright/test';
import { SEED_PASSWORD as password, seedListingAgent } from './seed';

/** Listing editor in the browser (S3-05): create, translate, publish SHARED, lock fields — all by autosave. */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
}

/**
 * Runs an edit, then waits for its autosave: a save request answered, then saved. Not the transient "Unsaved
 * changes" / "Saving…" text: on a big editor a Playwright action (`check`, `uncheck` re-read the box after the
 * click) can outlast the 800 ms debounce and the save, so the pending state may be over before it is looked for.
 */
async function autosaved(page: Page, edit: () => Promise<void>): Promise<void> {
  const status = page.getByTestId('save-status');
  const editor = new URL(page.url()).pathname;
  // The autosave is a server action: a POST to the editor's own URL.
  const saved = page.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === editor,
    { timeout: 15_000 },
  );
  await edit();
  await saved;
  await expect(status).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('editor-error')).toHaveCount(0);
}

test('[S3-05] create → add translations → publish SHARED → appears in own list; field lock toggles persist', async ({
  page,
}) => {
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
  const seeded = await seedListingAgent();
  await login(page, seeded.email);

  // The navigation leads to the agency's listings; a new one starts with what and where.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Listings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
  await page.getByRole('link', { name: 'New listing' }).click();
  // The list page has its own "Location" filter and column toggle: wait until the form replaced it.
  await expect(page).toHaveURL(/\/en\/listings\/new$/);
  await page.getByLabel('Property type').selectOption({ label: seeded.propertyType });
  await page.getByLabel('Location').selectOption({ label: seeded.location });
  await page.getByRole('button', { name: 'Create listing' }).click();
  await expect(page).toHaveURL(/\/en\/listings\/[0-9a-f-]{36}$/);
  const editorUrl = page.url();
  const ref = (await page.getByRole('heading', { level: 1 }).innerText()).replace('Listing ', '').trim();
  expect(ref).toMatch(/^[2-9A-Z]{8}$/);

  // Translations: Spanish (the default content locale) first, then English; each tab shows its origin.
  await expect(page.getByTestId('origin-es')).toHaveText('Not written');
  await autosaved(page, () => page.getByLabel('Title', { exact: true }).fill('Villa con vistas al mar'));
  await expect(page.getByTestId('origin-es')).toHaveText('Written');
  await expect(page.getByLabel('URL slug')).toHaveValue('villa-con-vistas-al-mar');
  await page.getByRole('tab', { name: /English/ }).click();
  await autosaved(page, () => page.getByLabel('Title', { exact: true }).fill('Sea-view villa'));
  await expect(page.getByTestId('origin-en')).toHaveText('Written');

  // Specs, a feature, the price and two field locks.
  await autosaved(page, async () => {
    await page.getByLabel('Bedrooms').fill('4');
    await page.getByLabel(seeded.feature).check();
    await page.getByLabel('Price', { exact: true }).fill('850000');
    await page.getByLabel('Lock against feed imports: Price').check();
    await page.getByLabel('Lock against feed imports: Position').check();
  });

  // A refused value shows its message and marks the field; fixing it saves.
  await page.getByLabel('Bathrooms').fill('two');
  await expect(page.getByTestId('editor-error')).toContainText('Some values are not valid', { timeout: 15_000 });
  await expect(page.getByLabel('Bathrooms')).toHaveAttribute('aria-invalid', 'true');
  // After an error the status stays "Not saved" through the debounce and "Saving…" may be too short to see:
  // wait for the save itself.
  await page.getByLabel('Bathrooms').fill('2');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('editor-error')).toHaveCount(0);
  await expect(page.getByLabel('Bathrooms')).not.toHaveAttribute('aria-invalid', 'true');

  // Publish to the network: active and shared.
  await autosaved(page, async () => {
    await page.getByLabel('Status', { exact: true }).selectOption('ACTIVE');
    await page.getByLabel('Visibility', { exact: true }).selectOption('SHARED');
  });

  // Everything persisted: reload the editor.
  await page.goto(editorUrl);
  await expect(page.getByLabel('Lock against feed imports: Price')).toBeChecked();
  await expect(page.getByLabel('Lock against feed imports: Position')).toBeChecked();
  await expect(page.getByLabel('Lock against feed imports: Status')).not.toBeChecked();
  await expect(page.getByLabel('Visibility', { exact: true })).toHaveValue('SHARED');
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('ACTIVE');
  await expect(page.getByLabel('Bedrooms')).toHaveValue('4');
  await expect(page.getByLabel(seeded.feature)).toBeChecked();
  await expect(page.getByTestId('origin-es')).toHaveText('Written');
  await expect(page.getByTestId('origin-en')).toHaveText('Written');

  // Unlocking persists too.
  await autosaved(page, () => page.getByLabel('Lock against feed imports: Price').uncheck());
  await page.reload();
  await expect(page.getByLabel('Lock against feed imports: Price')).not.toBeChecked();
  await expect(page.getByLabel('Lock against feed imports: Position')).toBeChecked();

  // It appears in the agency's own list, shared.
  await page.getByRole('link', { name: 'Back to listings' }).click();
  const row = page.getByTestId('listings-table').getByRole('row').filter({ hasText: ref });
  await expect(row).toContainText('Shared (verified agencies)');
  await expect(row).toContainText('Active');
  await expect(row).toContainText(seeded.propertyType);
  await expect(row).toContainText('850,000');
  // S3-07 list filters: "Only mine" is a filter checkbox now.
  await page.getByTestId('listing-filters').getByLabel('Only mine').check();
  await page.getByTestId('listing-filters').getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/mine/);
  await expect(page.getByTestId('listings-table')).toContainText(ref);
});
