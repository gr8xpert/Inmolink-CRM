import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEED_PASSWORD as password, seedAgent, seedImportAdmin } from './seed';
import { passTwoFactor } from './two-factor';

/** Editing a contact (S17-F28) and importing contacts from a CSV file (S17-F29) in the browser; the run is the worker's. */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, password);
}

async function addContact(page: Page, firstName: string, email: string): Promise<void> {
  await page.goto('/en/contacts/new');
  await page.getByLabel('First name').fill(firstName);
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Create contact' }).click();
  await expect(page.getByRole('heading', { level: 1, name: firstName })).toBeVisible();
}

test('[S17-F28] edit a contact from its page: fields saved, consent recorded, a stale form refused', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const admin = await seedImportAdmin();
  await login(page, admin.email);
  const tag = randomBytes(4).toString('hex');
  await addContact(page, 'Marta', `marta-${tag}@example.com`);
  await expect(page.getByText('No consent recorded yet.')).toBeVisible();
  const contactUrl = page.url();

  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit contact' })).toBeVisible();
  await expect(page.getByLabel('E-mails')).toHaveValue(`marta-${tag}@example.com`);

  // A second tab opened on the same version, before the save below.
  const stale = await context.newPage();
  await stale.goto(`${contactUrl}/edit`);
  await expect(stale.getByLabel('First name')).toHaveValue('Marta');

  // A name change alone records no consent.
  await page.getByLabel('First name').fill('Martina');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Martina' })).toBeVisible();
  await expect(page.getByText('No consent recorded yet.')).toBeVisible();

  await stale.getByLabel('First name').fill('Stale');
  await stale.getByRole('button', { name: 'Save changes' }).click();
  await expect(stale.getByRole('alert').filter({ hasText: 'Someone changed this contact meanwhile' })).toBeVisible();
  await expect(stale.getByLabel('First name')).toHaveValue('Stale');
  await stale.close();

  // Ticking a consent is a record in the history.
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Agrees to marketing').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await expect(page.getByText('No consent recorded yet.')).toBeHidden();
  await expect(page.getByText(/Marketing.*given/)).toBeVisible();
});

test('[S17-F30] an agent is not offered the contact import, and the upload is refused', async ({ page }) => {
  const agent = await seedAgent();
  await login(page, agent.email);
  await page.goto('/en/contacts');
  await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import contacts' })).toBeHidden();
  await page.goto('/en/contacts/import');
  await expect(page.getByTestId('contact-import-admins-only')).toBeVisible();
  await expect(page.getByTestId('contact-import-file')).toBeHidden();
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/contacts/import', { method: 'POST', body: 'Name,Email\nX,x@example.com\n' });
    return res.status;
  });
  expect(status).toBe(403);
});

test('[S17-F29] import a CSV: confirm columns, see errors and duplicates, import, no consent invented', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const admin = await seedImportAdmin();
  await login(page, admin.email);
  const tag = randomBytes(4).toString('hex');
  const known = `known-${tag}@example.com`;
  await addContact(page, 'Known', known);
  const knownUrl = page.url();

  await page.goto('/en/contacts');
  await page.getByRole('link', { name: 'Import contacts' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import contacts' })).toBeVisible();

  const file = [
    'Name,Email,Newsletter',
    `Nuria Sanz,nuria-${tag}@example.com,yes`,
    `Nuria Again,nuria-${tag}@example.com,yes`,
    `Other Name,${known},yes`,
    'Broken,not-an-address,',
  ].join('\n');
  await page.getByTestId('contact-import-file').setInputFiles({
    name: 'contacts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(file),
  });

  // The guesses are shown for confirming; the marketing column is left for the person to choose.
  await expect(page.getByLabel('Goes to: Name')).toHaveValue('fullName');
  await expect(page.getByLabel('Goes to: Email')).toHaveValue('emails');
  await expect(page.getByLabel('Goes to: Newsletter')).toHaveValue('');
  await expect(page.getByTestId('contact-import-no-consent')).toBeVisible();
  await expect(page.getByTestId('contact-import-start')).toBeHidden();

  await page.getByRole('button', { name: 'Check the rows' }).click();
  const preview = page.getByTestId('contact-import-preview');
  await expect(preview).toContainText('1 new · 1 already contacts · 1 repeated in the file · 1 with errors');
  await expect(preview).toContainText('0 of these rows would get marketing consent.');
  await expect(preview).toContainText('An e-mail is not valid');
  await expect(preview.getByRole('link', { name: 'Open the contact' })).toHaveAttribute('href', /\/contacts\//);

  // Changing an option makes the check out of date.
  await page.getByLabel('Add its new details to the contact').check();
  await expect(page.getByTestId('contact-import-start')).toBeHidden();
  await page.getByLabel('Skip the row').check();
  await page.getByRole('button', { name: 'Check the rows' }).click();
  await expect(preview).toBeVisible();

  await page.getByTestId('contact-import-start').click();
  const run = page.getByTestId('contact-import-run');
  await expect(run).toContainText('Import finished.', { timeout: 60_000 });
  await expect(run).toContainText('1 created · 0 merged · 2 skipped · 1 not imported');
  await expect(run).toContainText('Row 5');
  await expect(page.getByTestId('contact-import-recent')).toContainText('Done');

  // The new contact has no consent; the duplicate keeps its name.
  await page.goto('/en/contacts');
  await page.getByRole('link', { name: 'Nuria Sanz' }).click();
  await expect(page.getByText('No consent recorded yet.')).toBeVisible();
  await page.goto(knownUrl);
  await expect(page.getByRole('heading', { level: 1, name: 'Known' })).toBeVisible();
});
