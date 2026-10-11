import { TwoFactorCode } from '@inmolink/contracts';
import { authCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { checkLimits, clientIp, LIMITS } from './limits';

/**
 * Second-factor code checks for the web (S1-04): validate, rate-limit per user and per IP (fail closed,
 * counted before any check), then call identity. Used by the challenge, enrolment and security forms.
 */
export type CodeFailure = 'input' | 'rate_limited' | 'invalid';
export type CodeResult<T> = { ok: true; value: T } | { ok: false; code: CodeFailure };

export async function withCodeCheck<T>(
  input: { userId: string; code: unknown; forwardedFor: string | null },
  check: (code: TwoFactorCode) => Promise<T>,
  limiter?: RateLimiter,
): Promise<CodeResult<T>> {
  const parsed = TwoFactorCode.safeParse(input.code);
  if (!parsed.success) return { ok: false, code: 'input' };
  const ip = await clientIp(input.forwardedFor);
  const wait = await checkLimits(
    [
      [LIMITS.mfaUser, input.userId],
      [LIMITS.mfaUserDay, input.userId],
      [LIMITS.mfaIp, ip],
    ],
    limiter,
  );
  if (wait > 0) return { ok: false, code: 'rate_limited' };
  try {
    return { ok: true, value: await check(parsed.data) };
  } catch (err) {
    if (isAppError(err) && err.code === 'MFA_CODE_INVALID') return { ok: false, code: 'invalid' };
    throw err;
  }
}

/** The login challenge: TOTP or recovery code, optionally remembering this browser for 30 days. */
export function attemptChallenge(
  session: { userId: string; sessionVersion: number },
  input: { code: unknown; rememberDevice: boolean; forwardedFor: string | null },
  limiter?: RateLimiter,
) {
  return withCodeCheck(
    { userId: session.userId, code: input.code, forwardedFor: input.forwardedFor },
    (code) => identity.verifySecondFactor(authCtx(newId()), { ...session, code, rememberDevice: input.rememberDevice }),
    limiter,
  );
}

/** "Remember this browser": httpOnly, Secure (`__Host-`) in production, sent only to this origin. */
export function rememberedDeviceCookie(secure: boolean) {
  return {
    name: `${secure ? '__Host-' : ''}inmolink.mfa-device`,
    options: { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' },
  };
}

/** One cookie value from a `Cookie` header, or undefined. */
export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}
