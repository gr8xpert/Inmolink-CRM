import { TwoFactorCode } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { checkLimits, clientIp, LIMITS } from './limits';
import { requestAuthCtx } from './request-id';

/**
 * Second-factor code checks for the web (S1-04): validate, rate-limit per user and per IP (fail closed,
 * counted before any check), then call identity. Used by the challenge, enrolment and security forms.
 */
export type CodeFailure = 'input' | 'rate_limited' | 'invalid' | 'password';
export type CodeResult<T> = { ok: true; value: T } | { ok: false; code: CodeFailure };

export async function withCodeCheck<T>(
  input: { userId: string; code: unknown; forwardedFor: string | null },
  check: (code: TwoFactorCode) => Promise<T>,
  limiter?: RateLimiter,
): Promise<CodeResult<T>> {
  const parsed = TwoFactorCode.safeParse(input.code);
  if (!parsed.success) return { ok: false, code: 'input' };
  if (!(await withinLimits(input, limiter))) return { ok: false, code: 'rate_limited' };
  try {
    return { ok: true, value: await check(parsed.data) };
  } catch (err) {
    if (isAppError(err) && err.code === 'MFA_CODE_INVALID') return { ok: false, code: 'invalid' };
    throw err;
  }
}

/**
 * A fresh-password check before an account setting changes (enrolment, S1-F8), under the same limits as
 * code checks: a session someone left open must not become a password-guessing oracle.
 */
export async function withPasswordCheck<T>(
  input: { userId: string; password: unknown; forwardedFor: string | null },
  check: (password: string) => Promise<T>,
  limiter?: RateLimiter,
): Promise<CodeResult<T>> {
  if (typeof input.password !== 'string' || input.password === '' || input.password.length > 1_024) {
    return { ok: false, code: 'input' };
  }
  if (!(await withinLimits(input, limiter))) return { ok: false, code: 'rate_limited' };
  try {
    return { ok: true, value: await check(input.password) };
  } catch (err) {
    if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') return { ok: false, code: 'password' };
    throw err;
  }
}

/** Counts the attempt against the per-client, per-user and per-IP buckets; false when any is spent. */
async function withinLimits(
  input: { userId: string; forwardedFor: string | null },
  limiter?: RateLimiter,
): Promise<boolean> {
  const ip = await clientIp(input.forwardedFor);
  const client = `${input.userId}|${ip}`;
  const wait = await checkLimits(
    [
      [LIMITS.mfaUserIp, client],
      [LIMITS.mfaUserIpDay, client],
      [LIMITS.mfaUserDay, input.userId],
      [LIMITS.mfaIp, ip],
    ],
    limiter,
  );
  return wait === 0;
}

/**
 * The login challenge: TOTP or recovery code, optionally remembering this browser for 30 days. The proof is minted for
 * this web session (`sessionId`, S16-F10): the session callback refuses it from any other.
 */
export function attemptChallenge(
  session: { userId: string; sessionVersion: number; sessionId: string },
  input: { code: unknown; rememberDevice: boolean; forwardedFor: string | null },
  limiter?: RateLimiter,
) {
  return withCodeCheck(
    { userId: session.userId, code: input.code, forwardedFor: input.forwardedFor },
    async (code) =>
      identity.verifySecondFactor(await requestAuthCtx(), { ...session, code, rememberDevice: input.rememberDevice }),
    limiter,
  );
}

const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * S16-F10: the web session id a code check binds its proof to. A session from before S12-06 has none: `assignId` (an
 * empty session update) gives it one, and the caller must send the browser back to the form **before** a code is
 * checked — Auth.js rebuilds each update from the request's cookies, so the id written now is only seen by the next
 * request (a proof minted in this one would match no session, and the code would be spent). Null = assigned, retry.
 */
export async function sessionIdForCode(
  user: { sessionId?: string },
  assignId: () => Promise<unknown>,
): Promise<string | null> {
  if (typeof user.sessionId === 'string' && SID_RE.test(user.sessionId)) return user.sessionId;
  await assignId();
  return null;
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
