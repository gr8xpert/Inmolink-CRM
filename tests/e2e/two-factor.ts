import { totpCode, totpStep } from '@inmolink/platform/crypto';
import { expect, type Page } from '@playwright/test';

/**
 * Second factor in browser tests (S1-04): staff and admins land on `/two-factor` after login. The
 * first time they enrol (the test reads the setup key off the page, like a person typing it into an
 * app); later they pass the challenge and ask to be remembered. A TOTP step is accepted once, so the
 * helper never reuses one.
 */
const apps = new Map<string, { secret: string; lastStep: number }>();

function nextCode(email: string): string {
  const app = apps.get(email);
  if (!app) throw new Error(`no authenticator enrolled for ${email}`);
  const now = totpStep(new Date());
  // The server accepts one step of drift either way; take the first one not used yet.
  const step = Math.max(now - 1, app.lastStep + 1);
  if (step > now + 1) throw new Error('all codes of this window are used; wait 30 s');
  app.lastStep = step;
  return totpCode(app.secret, step);
}

/** After "Log in": completes enrolment or the challenge if the dashboard asks for it. */
export async function passTwoFactor(page: Page, email: string): Promise<void> {
  // Login lands on `/en` first; the dashboard then redirects to `/two-factor` when 2FA is owed. Wait
  // for a page that is not about to move: the dashboard itself, or one of the two 2FA views.
  const dashboard = page.getByRole('heading', { name: 'Dashboard' });
  const twoFactor = page.getByRole('heading', { name: /two-step verification/i });
  await expect(dashboard.or(twoFactor)).toBeVisible();
  if (await dashboard.isVisible()) return;
  const setupKey = page.getByTestId('totp-secret');
  if (await setupKey.isVisible()) {
    const secret = ((await setupKey.textContent()) ?? '').replaceAll(/\s/g, '');
    apps.set(email, { secret, lastStep: 0 });
    await page.getByLabel('Code from the app').fill(nextCode(email));
    await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
    await expect(page.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
    await page.getByRole('link', { name: 'Continue' }).click();
  } else {
    await page.getByLabel('Code', { exact: true }).fill(nextCode(email));
    await page.getByLabel('Remember this browser for 30 days').check();
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page).toHaveURL(/\/en$/);
}
