import { totpCode, totpStep } from '@inmolink/platform/crypto';
import { expect, type Page } from '@playwright/test';

/**
 * Second factor in browser tests (S1-04): staff and admins land on `/two-factor` after login. The
 * first time they enrol (the test reads the setup key off the page, like a person typing it into an
 * app); later they pass the challenge and ask to be remembered. A TOTP step is accepted once, so the
 * helper never reuses one.
 */
const apps = new Map<string, { secret: string; used: Set<number> }>();

function nextCode(email: string): string {
  const app = apps.get(email);
  if (!app) throw new Error(`no authenticator enrolled for ${email}`);
  const now = totpStep(new Date());
  // The server accepts one step of drift either way. The current step first, then the next: the previous
  // one is the last resort, since it expires at the next boundary (an S1-10 e2e run hit that: the code
  // was computed a second before the boundary and refused once it arrived).
  for (const step of [now, now + 1, now - 1]) {
    if (app.used.has(step)) continue;
    app.used.add(step);
    return totpCode(app.secret, step);
  }
  throw new Error('all codes of this window are used; wait 30 s');
}

/**
 * After "Log in": completes enrolment or the challenge if the dashboard asks for it. Enrolment starts
 * with the account password (S1-F8 step-up), so the helper needs the password the test logged in with.
 */
export async function passTwoFactor(page: Page, email: string, password: string): Promise<void> {
  // Login lands on `/en` first; the dashboard then redirects to `/two-factor` when 2FA is owed. Wait
  // for a page that is not about to move: the dashboard itself, or one of the two 2FA views.
  const dashboard = page.getByRole('heading', { name: 'Dashboard' });
  const twoFactor = page.getByRole('heading', { name: /two-step verification/i });
  await expect(dashboard.or(twoFactor)).toBeVisible();
  if (await dashboard.isVisible()) return;
  // Enrolment's fresh-password step (S1-F8): the setup key appears only after it.
  const passwordStep = page.getByLabel('Your password');
  if (await passwordStep.isVisible()) {
    await passwordStep.fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('totp-secret')).toBeVisible();
  }
  const setupKey = page.getByTestId('totp-secret');
  if (await setupKey.isVisible()) {
    const secret = ((await setupKey.textContent()) ?? '').replaceAll(/\s/g, '');
    apps.set(email, { secret, used: new Set() });
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
