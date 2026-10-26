import { randomBytes } from 'node:crypto';
import { expect, test } from './fixtures';
import { countEmails, waitForLink } from './mailpit';
import { testStackEnv } from './stack';
import { passTwoFactor } from './two-factor';

const API_URL = testStackEnv().API_URL as string;
const uniqueEmail = () => `e2e-${randomBytes(5).toString('hex')}@example.com`;

test('[S0-09] sign-up → verify email → log in → call an authenticated API route', async ({ page, request }) => {
  const email = uniqueEmail();
  const password = 'correct horse battery';

  await page.goto('/signup');
  await page.getByLabel('An estate agency').check();
  await page.getByLabel('Company name').fill('Costa Homes S.L.');
  await page.getByLabel('Your name').fill('Ana García');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');

  // Not verified yet: login is refused (and a fresh link is sent).
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('form-error')).toContainText('Please confirm your email first');

  // The fresh link replaces the sign-up one: wait for the second email, or the first (now dead) link wins the race.
  await expect.poll(() => countEmails(email, /Confirm your email/), { timeout: 60_000 }).toBe(2);
  const link = await waitForLink(email, /Confirm your email/);
  expect(link.pathname).toBe('/en/verify-email');
  await page.goto(link.href);
  await page.getByLabel('Password').fill('wrong password!');
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page.getByTestId('form-error')).toContainText('does not match this account');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/login\?verified=1$/);
  await expect(page.getByRole('status')).toContainText('Your email is confirmed');

  // `next dev` compiles a route on first use, and the login action renders the home route inside its
  // response: compile it now so the action's latency is not dominated by a cold compile.
  await page.request.get('/en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  // The founder is the agency admin: no dashboard (and no access token) before 2FA (S1-04).
  await expect(page).toHaveURL(/\/en\/two-factor$/);
  expect((await page.request.get('/session/token?aud=api')).status()).toBe(403);
  await passTwoFactor(page, email, password);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  // Server-side: web session → 15-minute api token → GET /v1/me on the API.
  await expect(page.getByTestId('api-check')).toContainText('API session check passed for user');

  // Browser-side: the same session mints a token the API accepts; a realtime token is refused.
  const minted = await page.request.get('/session/token?aud=api');
  expect(minted.status()).toBe(200);
  expect(minted.headers()['cache-control']).toBe('no-store');
  const { token } = (await minted.json()) as { token: string };
  const me = await request.get(`${API_URL}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(me.status()).toBe(200);
  // Sign-up created the agency-of-one (S1-01): the token carries it.
  expect(await me.json()).toMatchObject({ agencyId: expect.any(String), sessionVersion: 1 });

  const realtime = (await (await page.request.get('/session/token?aud=realtime')).json()) as { token: string };
  const wrongAudience = await request.get(`${API_URL}/v1/me`, {
    headers: { authorization: `Bearer ${realtime.token}` },
  });
  expect(wrongAudience.status()).toBe(401);

  // Logout ends the session: no more tokens.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/session/token?aud=api')).status()).toBe(401);
});

test('[S0-09] password reset: the emailed link works once and the new password logs in', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill('Joan Inmobiliaria');
  await page.getByLabel('Your name').fill('Joan');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('first password!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.goto((await waitForLink(email, /Confirm your email/)).href);
  await page.getByLabel('Password').fill('first password!');
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/verified=1/);

  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('valid for 60 minutes');

  const link = await waitForLink(email, /Reset your Inmolink password/);
  await page.goto(link.href);
  await page.getByLabel('New password').fill('second password!');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);

  // The same link again: refused.
  await page.goto(link.href);
  await page.getByLabel('New password').fill('third password!!');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByTestId('form-error')).toContainText('already been used or has expired');

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('second password!');
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, 'second password!');
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  expect(await countEmails(email, /Reset your Inmolink password/)).toBe(1);
});

test('[S0-11] the locale prefix decides the language, whatever the browser prefers', async ({ page }) => {
  await page.goto('/es/login');
  await expect(page).toHaveURL(/\/es\/login$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  // Links stay in the locale.
  await page.getByRole('link', { name: /Crea una cuenta/ }).click();
  await expect(page).toHaveURL(/\/es\/signup$/);
  expect((await page.request.get('/healthz')).status()).toBe(200);
  expect((await page.goto('/en/no-such-page'))?.status()).toBe(404);
});

test.describe('Spanish UI', () => {
  test.use({ locale: 'es-ES' });

  test('[S0-09] [S0-11] an unprefixed URL redirects to the browser locale; auth pages render in Spanish', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/es\/login$/);
    await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: 'Crea tu cuenta' })).toBeVisible();
    await expect(page.getByText('Al menos 10 caracteres.')).toBeVisible();
  });
});

test('[S1-01] a new agency is pending and completes its company details in onboarding', async ({ page }) => {
  const email = uniqueEmail();
  const password = 'correct horse battery';
  await page.goto('/signup');
  await page.getByLabel('A property developer').check();
  await page.getByLabel('Company name').fill('Nova Obra Promociones');
  await page.getByLabel('Your name').fill('Leo Martín');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');

  const link = await waitForLink(email, /Confirm your email/);
  await page.goto(link.href);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Confirm my email' }).click();
  await expect(page).toHaveURL(/\/login\?verified=1$/);
  await page.request.get('/en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await passTwoFactor(page, email, password);
  await expect(page.getByTestId('agency-pending')).toContainText('Nova Obra Promociones is waiting for verification');

  await page.getByRole('link', { name: 'Complete your company details' }).click();
  await expect(page.getByTestId('agency-status')).toHaveText('Pending verification');
  await page.getByLabel('CIF / NIF / NIE').fill('B12345675');
  await page.getByLabel('Address').fill('Calle Mayor 1');
  await page.getByLabel('City').fill('Marbella');
  await page.getByLabel('Postal code').fill('29601');
  await page.getByLabel('Region').selectOption('ES-AN');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.getByTestId('form-error')).toContainText('does not match the number');

  await page.getByLabel('CIF / NIF / NIE').fill('B12345674');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(page.getByTestId('form-saved')).toBeVisible();
});
