'use server';

import { RegisterInput, RequestPasswordResetInput, ResetPasswordInput, VerifyEmailInput } from '@inmolink/contracts';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { signIn, signOut } from '@/auth';
import { webConfig } from '@/server/env';
import { checkLimits, clientIp, LIMITS } from '@/server/limits';
import { requestLocale } from '@/server/locale';

/**
 * Auth form actions (transport only): validate with the contracts, rate-limit, call identity. The
 * error values are i18n keys under `auth.errors`.
 */
export interface FormState {
  error?:
    | 'invalidInput'
    | 'rateLimited'
    | 'invalidCredentials'
    | 'emailNotVerified'
    | 'tokenInvalid'
    | 'verifyPassword'
    | 'generic';
  /** Field names that failed validation. */
  fields?: string[];
  done?: boolean;
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
    locale: await requestLocale(),
  });
  if (!parsed.success) return invalid(parsed.error.issues);
  const wait = await checkLimits([
    [LIMITS.signupIp, await ip()],
    [LIMITS.signupEmail, parsed.data.email],
  ]);
  if (wait > 0) return { error: 'rateLimited' };
  await identity.register(authCtx(newId()), parsed.data);
  return { done: true };
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await signIn('credentials', { email: field(form, 'email'), password: field(form, 'password'), redirectTo: '/' });
  } catch (err) {
    if (err instanceof AuthError) {
      const code = (err as AuthError & { code?: string }).code;
      if (code === 'rate_limited') return { error: 'rateLimited' };
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
    await identity.verifyEmail(authCtx(newId()), parsed.data);
  } catch (err) {
    if (isAppError(err) && err.code === 'TOKEN_INVALID') return { error: 'tokenInvalid' };
    if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') return { error: 'verifyPassword' };
    throw err;
  }
  redirect('/login?verified=1');
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
  await identity.requestPasswordReset(authCtx(newId()), parsed.data);
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
    await identity.resetPassword(authCtx(newId()), parsed.data);
  } catch (err) {
    if (isAppError(err) && err.code === 'TOKEN_INVALID') return { error: 'tokenInvalid' };
    throw err;
  }
  redirect('/login?reset=1');
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' });
}
