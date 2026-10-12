import { chromium, expect, test } from '@playwright/test';
import lighthouse, { type Flags } from 'lighthouse';
import { SEED_PASSWORD, seedAgent } from './seed';
import { PORTS, testStackEnv } from './stack';

/** Dashboard shell (S1-10): Lighthouse accessibility on the authenticated frame. */

const WEB_URL = testStackEnv().WEB_URL as string;
const DEVTOOLS_PORT = PORTS.devtools;

/** Both form factors: the shell is a sidebar from `md` up and a menu toggle below. */
const FORM_FACTORS: Record<string, Pick<Flags, 'formFactor' | 'screenEmulation'>> = {
  mobile: { formFactor: 'mobile' },
  desktop: {
    formFactor: 'desktop',
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
  },
};

test('[S1-10] Lighthouse accessibility ≥ 90 on the shell (mobile and desktop)', async ({ page }) => {
  const { email } = await seedAgent();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/en$/);
  // The shell is up: the navigation, the account section and the main landmark.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();

  // Lighthouse loads the page itself, in a browser of its own: the session cookie travels as a header.
  const cookie = (await page.context().cookies(WEB_URL)).map((c) => `${c.name}=${c.value}`).join('; ');
  const browser = await chromium.launch({ channel: 'chromium', args: [`--remote-debugging-port=${DEVTOOLS_PORT}`] });
  try {
    for (const [name, emulation] of Object.entries(FORM_FACTORS)) {
      const result = await lighthouse(`${WEB_URL}/en`, {
        port: DEVTOOLS_PORT,
        logLevel: 'error',
        output: 'json',
        onlyCategories: ['accessibility'],
        throttlingMethod: 'provided',
        extraHeaders: { cookie },
        ...emulation,
      });
      const lhr = result?.lhr;
      if (!lhr) throw new Error(`Lighthouse returned no result (${name})`);
      // Signed in: the dashboard itself was audited, not the login page it would redirect to.
      expect(lhr.finalDisplayedUrl, name).toBe(`${WEB_URL}/en`);
      expect(lhr.runtimeError, name).toBeUndefined();
      const failing = Object.values(lhr.audits)
        .filter((a) => a.score !== null && a.score < 1)
        .map((a) => `${a.id}: ${a.title}`);
      const score = (lhr.categories.accessibility?.score ?? 0) * 100;
      console.log(`lighthouse accessibility (${name}): ${score}`);
      expect(
        score,
        `${name}: accessibility ${score}; failing audits: ${failing.join(' | ') || 'none'}`,
      ).toBeGreaterThanOrEqual(90);
    }
  } finally {
    await browser.close();
  }
});
