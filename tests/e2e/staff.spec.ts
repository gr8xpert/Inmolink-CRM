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
  await expect(page.getByTestId('api-check')).toHaveCount(0);
  await page.goto('/en/team');
  await expect(banner).toBeVisible();

  // Stopping ends it at once and returns to the agency in the console.
  await banner.getByRole('button', { name: 'Stop acting as this user' }).click();
  await expect(page.getByRole('status')).toContainText('You are no longer acting as another user.');
  await expect(banner).toHaveCount(0);
});

test('[S17-F46] a session stopped from another tab ends in the banner, not a redirect loop', async ({
  page,
  browser,
}) => {
  const { staff, company } = await seed();
  await login(page, staff);
  await page.getByRole('link', { name: 'Staff console' }).click();
  await page.getByLabel('Name or tax id').fill(company);
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByTestId('tenants').getByRole('link', { name: 'Open' }).click();
  await page.getByText('Act as Marta').click();
  await page.getByLabel(/^Reason \(support ticket, what/).fill('E2E: stopped from another tab');
  await page.getByRole('button', { name: 'Start acting as this user' }).click();
  const banner = page.getByTestId('impersonation-banner');
  await expect(banner).toContainText(`You are acting as Marta at ${company}`);

  // A second browser context holding the same cookies stops the session.
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const tabB = await other.newPage();
  await tabB.goto('/en');
  await tabB.getByRole('button', { name: 'Stop acting as this user' }).click();
  await expect(tabB.getByRole('status').first()).toContainText('You are no longer acting as another user.');
  await other.close();

  // Tab A still holds the cookie: it lands on the console, as the staff member, told the session is over.
  await page.goto('/en');
  await expect(page).toHaveURL(/\/en\/staff\/tenants\?notice=ended$/);
  await expect(banner).toContainText(`Your session acting as Marta at ${company} has ended`);
  await expect(banner.getByRole('button', { name: 'Stop acting as this user' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Filter' })).toBeVisible();

  // The login page, which sent the browser into the loop too, now answers, and no page acts as the member.
  await page.goto('/en/login');
  await expect(page).not.toHaveURL(/impersonation-ended/);
  await page.goto('/en');
  await expect(banner).toContainText('has ended');
  await expect(page.getByRole('link', { name: 'Staff console' })).toBeVisible();

  // Dismissing forgets it for good.
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page).toHaveURL(/\/en\/staff\/tenants/);
  await expect(banner).toHaveCount(0);
});
