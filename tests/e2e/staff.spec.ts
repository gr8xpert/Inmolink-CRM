import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '@inmolink/platform/crypto/password';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { testStackEnv } from './stack';
import { passTwoFactor } from './two-factor';

/** Staff console and impersonation in the browser (S1-09). */

const env = testStackEnv();
const password = 'correct horse battery';

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.request.get('/en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email);
}

async function logout(page: Page): Promise<void> {
  await page.goto('/en');
  await page.getByRole('button', { name: 'Log out' }).click();
}

/** Rows written as the database owner: a staff login, and an agency with one agent (no 2FA owed). */
async function seed(): Promise<{ staff: string; agent: string; company: string }> {
  const tag = randomBytes(4).toString('hex');
  const staff = `staff-${tag}@staff.inmolink.test`;
  const agent = `agent-${tag}@example.com`;
  const company = `Staffview ${tag} S.L.`;
  const admin = new pg.Client({ connectionString: env.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    const hash = await hashPassword(password);
    const [staffId, agentId, agencyId] = [randomUUID(), randomUUID(), randomUUID()];
    const user = `insert into users (id, email, password_hash, name, locale, email_verified_at) values ($1, $2, $3, $4, 'en', now())`;
    await admin.query(user, [staffId, staff, hash, 'Support']);
    await admin.query(`insert into staff_users (user_id, role) values ($1, 'STAFF_SUPPORT')`, [staffId]);
    await admin.query(user, [agentId, agent, hash, 'Marta']);
    await admin.query(`insert into agencies (agency_id, kind, name) values ($1, 'AGENCY', $2)`, [agencyId, company]);
    await admin.query(`insert into agency_settings (agency_id, enabled_locales) values ($1, '{en}')`, [agencyId]);
    await admin.query(
      `insert into agency_members (agency_id, user_id, role, name, email) values ($1, $2, 'AGENT', 'Marta', $3)`,
      [agencyId, agentId, agent],
    );
  } finally {
    await admin.end();
  }
  return { staff, agent, company };
}

test('[S1-09] non-staff get 404 on staff pages; staff act as a member with a reason, under a banner, and stop', async ({
  page,
}) => {
  const { staff, agent, company } = await seed();

  // Signed out and tenants: every staff page is a plain 404.
  for (const path of ['/en/staff', '/en/staff/tenants', '/en/staff/audit']) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
  await login(page, agent);
  for (const path of ['/en/staff', '/en/staff/tenants', '/en/staff/audit', '/en/staff/verification']) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
  await logout(page);

  // Staff find the agency and act as its agent.
  await login(page, staff);
  await page.getByRole('link', { name: 'Staff console' }).click();
  await page.getByLabel('Name or tax id').fill(company);
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByTestId('tenants').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(company);
  await page.getByText('Act as Marta').click();
  await page.getByLabel(/^Reason/).fill('E2E: checking what the agent sees');
  await page.getByRole('button', { name: 'Start acting as this user' }).click();

  // Every page shows the banner while the session is open; the dashboard is the agent's.
  const banner = page.getByTestId('impersonation-banner');
  await expect(banner).toContainText(`You are acting as Marta at ${company}`);
  await expect(page.getByTestId('api-check')).toBeVisible();
  await page.goto('/en/team');
  await expect(banner).toBeVisible();

  // Stopping ends it at once and returns to the agency in the console.
  await banner.getByRole('button', { name: 'Stop acting as this user' }).click();
  await expect(page.getByRole('status')).toContainText('You are no longer acting as another user.');
  await expect(banner).toHaveCount(0);
});
