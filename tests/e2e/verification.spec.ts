import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { waitForLink } from './mailpit';
import { testStackEnv } from './stack';
import { passTwoFactor } from './two-factor';

const env = testStackEnv();
const password = 'correct horse battery';
const uniqueEmail = () => `e2e-${randomBytes(5).toString('hex')}@example.com`;
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.request.get('/en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  // Agency admins and staff must use 2FA (S1-04).
  await passTwoFactor(page, email);
}

/** A staff login (no agency): staff are granted by a script, so the test writes the rows directly. */
async function createStaff(): Promise<string> {
  const email = `staff-${randomBytes(4).toString('hex')}@staff.inmolink.test`;
  const admin = new pg.Client({ connectionString: env.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    const id = randomUUID();
    await admin.query(
      `insert into users (id, email, password_hash, name, locale, email_verified_at) values ($1, $2, $3, 'Support', 'en', now())`,
      [id, email, await hashPassword(password)],
    );
    await admin.query(`insert into staff_users (user_id, role) values ($1, 'STAFF_SUPPORT')`, [id]);
  } finally {
    await admin.end();
  }
  return email;
}

/** The id of the agency's open verification request (read as the database owner). */
async function openRequestId(company: string): Promise<string> {
  const admin = new pg.Client({ connectionString: env.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      `select r.id from agency_verification_requests r join agencies a using (agency_id)
        where a.name = $1 and r.status = 'SUBMITTED'`,
      [company],
    );
    if (rows.length !== 1) throw new Error(`expected one open request for ${company}, found ${rows.length}`);
    return rows[0].id;
  } finally {
    await admin.end();
  }
}

test('[S1-03] an agency uploads and submits; staff approve; the agency is verified', async ({ page }) => {
  const email = uniqueEmail();
  const company = `Verified ${randomBytes(3).toString('hex')} S.L.`;
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Your name').fill('Marta');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  const link = await waitForLink(email, /Confirm your email/);
  await page.goto(link.href);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/login\?verified=1$/);
  await login(page, email);

  await page.getByRole('link', { name: 'Complete your company details' }).click();
  await page.getByLabel('CIF / NIF / NIE').fill('B12345674');
  await page.getByLabel('Address').fill('Calle Mayor 1');
  await page.getByLabel('City').fill('Marbella');
  await page.getByLabel('Postal code').fill('29601');
  await page.getByLabel('Region').selectOption('ES-AN');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.getByTestId('form-saved')).toBeVisible();

  // Upload through the route handler (multipart), then send.
  await page.goto('/en/verification');
  await expect(page.getByTestId('verification-status')).toContainText('Not verified yet');
  await page.getByLabel('Document type').selectOption('TAX_ID');
  await page.getByLabel(/^File/).setInputFiles({ name: 'cif.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByRole('status')).toContainText('Document uploaded.');
  await expect(page.getByTestId('verification-documents')).toContainText('cif.pdf');
  // A file that only claims to be a PDF is refused by its content.
  await page
    .getByLabel(/^File/)
    .setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html></html>') });
  await page.getByRole('button', { name: 'Upload' }).click();
  // The page's own alert, not Next's route announcer (also role=alert).
  await expect(page.getByRole('main').getByRole('alert')).toContainText('not a PDF, PNG, JPEG or WebP');
  await page.getByRole('button', { name: 'Send for verification' }).click();
  await expect(page.getByRole('status')).toContainText('Sent.');
  await page.goto('/en');
  await page.getByRole('button', { name: 'Log out' }).click();

  // A tenant user does not even see that the staff pages exist.
  await login(page, email);
  expect((await page.goto('/en/staff/verification'))?.status()).toBe(404);
  await page.goto('/en');
  await page.getByRole('button', { name: 'Log out' }).click();

  // Staff review and approve.
  const staff = await createStaff();
  await login(page, staff);
  await page.getByRole('link', { name: 'Verification queue (staff)' }).click();
  await expect(page.getByTestId('verification-queue')).toBeVisible();
  // The shared test database holds other runs' open requests, oldest first: this one may be on a later
  // page, so open it by id rather than by its position in the queue.
  await page.goto(`/en/staff/verification/${await openRequestId(company)}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(company);
  await page.getByLabel('Reason (shown to the agency)').fill('CIF checked against AEAT\nDeeds match');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText('Approved. The agency is verified.');
  await expect(page.getByTestId('verification-decision')).toContainText('CIF checked against AEAT');
  await page.goto('/en');
  await page.getByRole('button', { name: 'Log out' }).click();

  // The agency sees it on its next request.
  await login(page, email);
  await page.goto('/en/verification');
  await expect(page.getByTestId('verification-status')).toContainText('Verified');
});
