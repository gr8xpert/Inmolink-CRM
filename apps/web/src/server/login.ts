import { LoginInput, type SessionUser } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { checkLimits, clientIp, LIMITS } from './limits';
import { requestAuthCtx } from './request-id';

export type LoginFailure = 'input' | 'rate_limited' | 'invalid' | 'unverified';
export type LoginResult = { ok: true; user: SessionUser } | { ok: false; code: LoginFailure };

/**
 * The credential check behind Auth.js `authorize()`: validate, rate-limit per IP and per email
 * (before any password work, so a locked-out attacker costs no Argon2 time), then verify. A valid
 * "remember this browser" token (S1-04) marks the login as having passed the second factor.
 */
export async function attemptLogin(
  credentials: unknown,
  forwardedFor: string | null,
  opts: { deviceToken?: string; limiter?: RateLimiter } = {},
): Promise<LoginResult> {
  const parsed = LoginInput.safeParse(credentials);
  if (!parsed.success) return { ok: false, code: 'input' };
  const ip = await clientIp(forwardedFor);
  const wait = await checkLimits(
    [
      [LIMITS.loginIp, ip],
      [LIMITS.loginEmailIp, `${parsed.data.email}|${ip}`],
      [LIMITS.loginEmail, parsed.data.email],
    ],
    opts.limiter,
  );
  if (wait > 0) return { ok: false, code: 'rate_limited' };
  try {
    const input = { ...parsed.data, deviceToken: opts.deviceToken };
    return { ok: true, user: await identity.verifyCredentials(await requestAuthCtx(), input) };
  } catch (err) {
    if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') return { ok: false, code: 'invalid' };
    if (isAppError(err) && err.code === 'EMAIL_NOT_VERIFIED') return { ok: false, code: 'unverified' };
    throw err;
  }
}
