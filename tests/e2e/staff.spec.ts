import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SEED_PASSWORD as password, seedAgent, seedStaff } from './seed';
import { passTwoFactor } from './two-factor';

/** Staff console and impersonation in the browser (S1-09). */

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.request.get('/en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, password);
}

async function logout(page: Page): Promise<void> {
  await page.goto('/en');
  await page.getByRole('button', { name: 'Log out' }).click();
}

/** A staff login, and an agency with one agent (no 2FA owed). */
async function seed(): Promise<{ staff: string; agent: string; company: string }> {
  const [staff, agency] = await Promise.all([seedStaff(), seedAgent()]);
  return { staff, agent: agency.email, company: agency.company };
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
  await page.getByLabel(/^Reason \(support ticket, what/).fill('E2E: checking what the agent sees');
  await page.getByRole('button', { name: 'Start acting as this user' }).click();

  // Every page shows the banner while the session is open; the dashboard is the agent's.
  const banner = page.getByTestId('impersonation-banner');
  await expect(banner).toContainText(`You are acting as Marta at ${company}`);
  // The banner counts down to the end of the session (S1-F9) and keeps ticking.
  const countdown = banner.getByTestId('impersonation-countdown');
  await expect(countdown).toHaveText(/^\d+:\d{2} left$/);
  const before = await countdown.innerText();
  await expect.poll(() => countdown.innerText(), { timeout: 5_000 }).not.toBe(before);
  await expect(page.getByTestId('api-check')).toBeVisible();
  await page.goto('/en/team');
  await expect(banner).toBeVisible();

  // Stopping ends it at once and returns to the agency in the console.
  await banner.getByRole('button', { name: 'Stop acting as this user' }).click();
  await expect(page.getByRole('status')).toContainText('You are no longer acting as another user.');
  await expect(banner).toHaveCount(0);
});
