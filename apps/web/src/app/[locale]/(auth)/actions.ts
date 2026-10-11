'use server';

import {
  AcceptInviteInput,
  RegisterInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { headers } from 'next/headers';
import { AuthError } from 'next-auth';
import { getLocale } from 'next-intl/server';
import { signIn, signOut } from '@/auth';
import { getPathname, redirect } from '@/i18n/navigation';
import { webConfig } from '@/server/env';
import { checkLimits, clientIp, LIMITS } from '@/server/limits';
import { requestAuthCtx } from '@/server/request-id';

/**
 * Auth form actions (transport only): validate with the contracts, rate-limit, call identity. The
 * error values are i18n keys under `auth.errors`.
 */
export interface FormState {
  error?:
    | 'invalidInput'
    | 'rateLimited'
    | 'challengeRequired'
    | 'invalidCredentials'
    | 'emailNotVerified'
    | 'tokenInvalid'
    | 'verifyPassword'
    | 'inviteEmailInUse'
    | 'generic';
  /** Field names that failed validation. */
  fields?: string[];
  done?: boolean;
  /** Login only: show the Turnstile challenge on the next attempt (S1-F5). */
  challenge?: boolean;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : undefined;
};

const invalid = (issues: { path: PropertyKey[] }[]): FormState => ({
  error: 'invalidInput',
  fields: [...new Set(issues.map((i) => String(i.path[0])))],
});

async function ip(): Promise<string> {
  return clientIp((await headers()).get('x-forwarded-for'));
}

export async function signupAction(_prev: FormState, form: FormData): Promise<FormState> {
  await webConfig();
  const parsed = RegisterInput.safeParse({
    email: field(form, 'email'),
    password: field(form, 'password'),
    name: field(form, 'name'),
    accountKind: field(form, 'accountKind'),
    companyName: field(form, 'companyName'),
    // The route locale becomes the account's UI and email language.
    locale: await getLocale(),
  });
  if (!parsed.success) return invalid(parsed.error.issues);
  const wait = await checkLimits([
    [LIMITS.signupIp, await ip()],
    [LIMITS.signupEmail, parsed.data.email],
  ]);
  if (wait > 0) return { error: 'rateLimited' };
  await identity.register(await requestAuthCtx(), parsed.data);
  return { done: true };
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await signIn('credentials', {
      email: field(form, 'email'),
      password: field(form, 'password'),
      turnstile: field(form, 'cf-turnstile-response'),
      redirectTo: getPathname({ href: '/', locale: await getLocale() }),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      const code = (err as AuthError & { code?: string }).code;
      if (code === 'rate_limited') return { error: 'rateLimited' };
      if (code === 'challenge') return { error: 'challengeRequired', challenge: true };
      if (code === 'unverified') return { error: 'emailNotVerified' };
      if (code === 'input' || code === 'invalid') return { error: 'invalidCredentials' };
      return { error: 'generic' };
    }
    throw err; // NEXT_REDIRECT on success
  }
  return {};
}

export async function verifyEmailAction(_prev: FormState, form: FormData): Promise<FormState> {
  await webConfig();
  const parsed = VerifyEmailInput.safeParse({ token: field(form, 'token'), password: field(form, 'password') });
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === 'token')
      ? { error: 'tokenInvalid' }
      : invalid(parsed.error.issues);
  }
  if ((await checkLimits([[LIMITS.verifyIp, await ip()]])) > 0) return { error: 'rateLimited' };
  try {
    await identity.verifyEmail(await requestAuthCtx(), parsed.data);
  } catch (err) {
    if (isAppError(err) && err.code === 'TOKEN_INVALID') return { error: 'tokenInvalid' };
    if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') return { error: 'verifyPassword' };
    throw err;
  }
  return redirect({ href: '/login?verified=1', locale: await getLocale() });
}

export async function forgotPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  await webConfig();
  const parsed = RequestPasswordResetInput.safeParse({ email: field(form, 'email') });
  if (!parsed.success) return invalid(parsed.error.issues);
  const wait = await checkLimits([
    [LIMITS.resetRequestIp, await ip()],
    [LIMITS.resetRequestEmail, parsed.data.email],
  ]);
  if (wait > 0) return { error: 'rateLimited' };
  await identity.requestPasswordReset(await requestAuthCtx(), parsed.data);
  return { done: true };
}

export async function resetPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  await webConfig();
  const parsed = ResetPasswordInput.safeParse({ token: field(form, 'token'), password: field(form, 'password') });
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === 'token')
      ? { error: 'tokenInvalid' }
      : invalid(parsed.error.issues);
  }
  if ((await checkLimits([[LIMITS.resetSubmitIp, await ip()]])) > 0) return { error: 'rateLimited' };
  try {
    await identity.resetPassword(await requestAuthCtx(), parsed.data);
  } catch (err) {
    if (isAppError(err) && err.code === 'TOKEN_INVALID') return { error: 'tokenInvalid' };
    throw err;
  }
  return redirect({ href: '/login?reset=1', locale: await getLocale() });
}

/** Invite link (S1-02): creates the account in the inviting agency, then sends the user to log in. */
export async function acceptInviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  await webConfig();
  const parsed = AcceptInviteInput.safeParse({
    token: field(form, 'token'),
    name: field(form, 'name'),
    password: field(form, 'password'),
  });
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === 'token')
      ? { error: 'tokenInvalid' }
      : invalid(parsed.error.issues);
  }
  if ((await checkLimits([[LIMITS.inviteAcceptIp, await ip()]])) > 0) return { error: 'rateLimited' };
  try {
    await identity.acceptInvite(await requestAuthCtx(), parsed.data);
  } catch (err) {
    if (isAppError(err) && err.code === 'TOKEN_INVALID') return { error: 'tokenInvalid' };
    if (isAppError(err) && err.code === 'INVITE_EMAIL_IN_USE') return { error: 'inviteEmailInUse' };
    throw err;
  }
  return redirect({ href: '/login?joined=1', locale: await getLocale() });
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: getPathname({ href: '/login', locale: await getLocale() }) });
}
