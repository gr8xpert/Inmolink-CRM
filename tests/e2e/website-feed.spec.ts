import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEED_PASSWORD as password, seedImportAdmin } from './seed';
import { passTwoFactor } from './two-factor';

/**
 * The website's XML feed card (S7-F8): an agency admin turns the feed on, copies the URLs (shown once) and rotates the
 * token from the dashboard; an IFRAME site shows its embed address.
 */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, password);
}

const FEED_URL = /^https?:\/\/[^/]+\/v2\/feeds\/([A-Za-z0-9_-]{43})\/(kyero|inmolink)\.xml$/;

test('[S7-F8] an agency admin turns the feed on, copies the URLs and rotates the token from the dashboard', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const admin = await seedImportAdmin();
  await login(page, admin.email);

  // An IFRAME website framed by the agency's own domain.
  await page.goto('/en/websites/new');
  await page.locator('#site-name').fill('Embedded search');
  await page.locator('#site-mode').selectOption('IFRAME');
  await page.locator('#site-domains').fill('www.e2e-embed.example');
  await page.getByRole('button', { name: 'Add website' }).click();
  await expect(page.getByText('Website added.')).toBeVisible();
  await page.getByRole('link', { name: 'Embedded search' }).click();

  // The embed address, for the site's domains only.
  await expect(page.getByTestId('embed-url')).toHaveText(/\/embed\/[0-9a-f-]{36}\/en$/);
  const card = page.getByTestId('feed-card');
  await expect(card.getByTestId('feed-status')).toHaveText('Off');

  // On: the URLs are shown once, to copy.
  await card.getByRole('button', { name: 'Turn the feed on' }).click();
  const issued = card.getByTestId('issued-feed-urls');
  await expect(issued).toBeVisible();
  const kyero = await issued.getByLabel('Kyero v3').inputValue();
  const generic = await issued.getByLabel('Generic XML').inputValue();
  const [, token, file] = FEED_URL.exec(kyero) ?? [];
  expect(file).toBe('kyero');
  expect(FEED_URL.exec(generic)?.[1]).toBe(token);
  await issued.getByRole('link', { name: 'Done' }).click();
  await expect(card.getByTestId('feed-status')).toHaveText('On');
  // Only the token's last characters stay on the page.
  await expect(card).toContainText(`…${token?.slice(-4)}`);
  await expect(page.locator('body')).not.toContainText(token as string);

  // Rotate: new URLs, the old token is gone.
  await card.getByRole('button', { name: 'New token' }).click();
  const rotated = await card.getByTestId('issued-feed-urls').getByLabel('Kyero v3').inputValue();
  const newToken = FEED_URL.exec(rotated)?.[1];
  expect(newToken).toBeDefined();
  expect(newToken).not.toBe(token);
  await card.getByRole('link', { name: 'Done' }).click();
  await expect(card).toContainText(`…${newToken?.slice(-4)}`);

  // Off.
  await card.getByRole('button', { name: 'Turn the feed off' }).click();
  // The action redirects back with a notice (slow on a loaded test stack).
  await expect(page.getByText('The feed is off. Its addresses now answer 404.')).toBeVisible({ timeout: 45_000 });
  await expect(card.getByTestId('feed-status')).toHaveText('Off');
});
