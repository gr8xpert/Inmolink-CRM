'use server';

import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { cookies, headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { auth, updateSession } from '@/auth';
import { redirect } from '@/i18n/navigation';
import { webConfig } from '@/server/env';
import { readImpersonation } from '@/server/impersonation';
import { requestAuthCtx } from '@/server/request-id';
import {
  attemptChallenge,
  type CodeFailure,
  rememberedDeviceCookie,
  withCodeCheck,
  withPasswordCheck,
} from '@/server/two-factor';

/**
 * Two-factor forms (S1-04, transport only): the login challenge, enrolment, and the security page's
 * "new recovery codes" and "turn off". Each code check is rate-limited per user and IP. A passed
 * check hands identity's proof to the session (`updateSession`); the session callback verifies it.
 * Error values are i18n keys under `security.errors`.
 */
export interface TwoFactorFormState {
  error?: CodeFailure | 'forbidden' | 'generic';
  /** Shown once, after enrolment or regeneration. */
  recoveryCodes?: string[];
  done?: boolean;
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

async function signedIn() {
  const session = await auth();
  if (!session?.user?.id) return redirect({ href: '/login', locale: await getLocale() });
  return session.user;
}

async function forwardedFor(): Promise<string | null> {
  return (await headers()).get('x-forwarded-for');
}

/** The login challenge: TOTP or recovery code; optionally remembers this browser for 30 days. */
export async function challengeAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  const config = await webConfig();
  const user = await signedIn();
  const result = await attemptChallenge(
    { userId: user.id, sessionVersion: user.sessionVersion },
    { code: text(form, 'code'), rememberDevice: form.get('remember') === 'on', forwardedFor: await forwardedFor() },
  );
  if (!result.ok) return { error: result.code };
  await updateSession({ mfaProof: result.value.proof });
  const device = result.value.device;
  if (device) {
    const cookie = rememberedDeviceCookie(config.WEB_URL.startsWith('https://'));
    (await cookies()).set(cookie.name, device.token, { ...cookie.options, expires: device.expiresAt });
  }
  return redirect({ href: '/', locale: await getLocale() });
}

/**
 * Enrolment's first step (S1-F8): the account password again, then the pending secret is created here —
 * a POST — and the page only reads it. Staff and admins enrol the same way.
 */
export async function startEnrolmentAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  await webConfig();
  const user = await signedIn();
  if (await readImpersonation(user.id)) return { error: 'forbidden' };
  try {
    const result = await withPasswordCheck(
      { userId: user.id, password: text(form, 'password'), forwardedFor: await forwardedFor() },
      async (password) => identity.startEnrolment(await requestAuthCtx(), { userId: user.id, password }),
    );
    if (!result.ok) return { error: result.code };
  } catch (err) {
    if (isAppError(err) && err.code === 'MFA_ALREADY_ENABLED') return { error: 'generic' };
    throw err;
  }
  return redirect({ href: { pathname: '/two-factor', query: { setup: '1' } }, locale: await getLocale() });
}

/** Security page: forgets every remembered browser (S1-F8); each asks for a code again at its next login. */
export async function forgetBrowsersAction(): Promise<void> {
  await webConfig();
  const user = await signedIn();
  const locale = await getLocale();
  if (await readImpersonation(user.id)) return redirect({ href: '/', locale });
  await identity.forgetRememberedBrowsers(await requestAuthCtx(), { userId: user.id });
  return redirect({ href: { pathname: '/account/security', query: { forgotten: '1' } }, locale });
}

/** Enrolment's first code: turns 2FA on and shows the recovery codes once. */
export async function enrolAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  await webConfig();
  const user = await signedIn();
  // S1-09: no 2FA changes (enrolment included) while acting as someone else.
  if (await readImpersonation(user.id)) return { error: 'forbidden' };
  try {
    const result = await withCodeCheck(
      { userId: user.id, code: text(form, 'code'), forwardedFor: await forwardedFor() },
      async (code) =>
        identity.confirmEnrolment(await requestAuthCtx(), {
          userId: user.id,
          sessionVersion: user.sessionVersion,
          code,
        }),
    );
    if (!result.ok) return { error: result.code };
    await updateSession({ mfaProof: result.value.proof });
    return { recoveryCodes: result.value.recoveryCodes };
  } catch (err) {
    // Enabled meanwhile (another tab): the challenge is what is left.
    if (isAppError(err) && err.code === 'MFA_ALREADY_ENABLED')
      return redirect({ href: '/two-factor', locale: await getLocale() });
    throw err;
  }
}

/** Security page: a new set of recovery codes (needs a current code). */
export async function regenerateCodesAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  await webConfig();
  const user = await signedIn();
  // S1-09: no 2FA changes while acting as someone else (it would be the staff member's own, but never mid-impersonation).
  if (await readImpersonation(user.id)) return { error: 'forbidden' };
  const result = await withCodeCheck(
    { userId: user.id, code: text(form, 'code'), forwardedFor: await forwardedFor() },
    async (code) => identity.regenerateRecoveryCodes(await requestAuthCtx(), { userId: user.id, code }),
  );
  if (!result.ok) return { error: result.code };
  return { recoveryCodes: result.value.recoveryCodes };
}

/** Security page: turns 2FA off — refused for staff and admins. */
export async function disableAction(_prev: TwoFactorFormState, form: FormData): Promise<TwoFactorFormState> {
  await webConfig();
  const user = await signedIn();
  if (await readImpersonation(user.id)) return { error: 'forbidden' };
  try {
    const result = await withCodeCheck(
      { userId: user.id, code: text(form, 'code'), forwardedFor: await forwardedFor() },
      async (code) => identity.disableTwoFactor(await requestAuthCtx(), { userId: user.id, code }),
    );
    if (!result.ok) return { error: result.code };
  } catch (err) {
    if (isAppError(err) && err.code === 'FORBIDDEN') return { error: 'forbidden' };
    throw err;
  }
  return { done: true };
}
