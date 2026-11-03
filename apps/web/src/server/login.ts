import { LoginInput, type SessionUser } from '@inmolink/contracts';
import * as identity from '@inmolink/core/modules/identity';
import { isAppError } from '@inmolink/platform/errors';
import { clientIpFromForwarded } from '@inmolink/platform/http';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { webConfig } from './env';
import { checkLimits, clientIp, LIMITS } from './limits';
import { requestAuthCtx } from './request-id';
import { dashboardTurnstile } from './turnstile';

/** `challenge`: the per-email ceiling is reached — solve Turnstile to keep trying (S1-F5). */
export type LoginFailure = 'input' | 'rate_limited' | 'challenge' | 'invalid' | 'unverified';
export type LoginResult = { ok: true; user: SessionUser } | { ok: false; code: LoginFailure };

/** The widget's `data-action`; Siteverify must report the same, so a token from another form is refused. */
export const TURNSTILE_LOGIN_ACTION = 'login';

/**
 * The credential check behind Auth.js `authorize()`: validate, rate-limit, then verify the password.
 * Limits run before any password work, so a locked-out attacker costs no Argon2 time:
 * - per IP and per email-from-one-client: hard blocks — they only stop the client that is guessing;
 * - per email from anywhere (the distributed-guessing ceiling): a Turnstile step, not a block, so an
 *   attacker spraying one address cannot lock its owner out (S1-F5). Without Turnstile keys it blocks.
 * A valid "remember this browser" token (S1-04) marks the login as having passed the second factor.
 */
export async function attemptLogin(
  credentials: unknown,
  forwardedFor: string | null,
  opts: {
    deviceToken?: string;
    /** The widget's response (`cf-turnstile-response`), when the form showed the challenge. */
    turnstileToken?: string;
    limiter?: RateLimiter;
    turnstile?: TurnstileVerifier | null;
  } = {},
): Promise<LoginResult> {
  const parsed = LoginInput.safeParse(credentials);
  if (!parsed.success) return { ok: false, code: 'input' };
  const ip = await clientIp(forwardedFor);
  const [blocked, overCeiling] = await Promise.all([
    checkLimits(
      [
        [LIMITS.loginIp, ip],
        [LIMITS.loginEmailIp, `${parsed.data.email}|${ip}`],
      ],
      opts.limiter,
    ),
    checkLimits([[LIMITS.loginEmail, parsed.data.email]], opts.limiter),
  ]);
  if (blocked > 0) return { ok: false, code: 'rate_limited' };
  if (overCeiling > 0) {
    const verifier = opts.turnstile !== undefined ? opts.turnstile : await dashboardTurnstile();
    if (!verifier) return { ok: false, code: 'rate_limited' };
    const { TRUST_PROXY } = await webConfig();
    const solved =
      opts.turnstileToken !== undefined &&
      (await verifier.verify(opts.turnstileToken, {
        action: TURNSTILE_LOGIN_ACTION,
        remoteIp: clientIpFromForwarded(forwardedFor, TRUST_PROXY),
      }));
    if (!solved) return { ok: false, code: 'challenge' };
  }
  // S16-03: the daily hard cap counts every attempt that reaches the password check (below the ceiling, or past a
  // solved challenge) — never one refused at the challenge, so junk logins that never get a password check cannot
  // use it up and lock the owner out.
  if ((await checkLimits([[LIMITS.loginEmailDay, parsed.data.email]], opts.limiter)) > 0) {
    return { ok: false, code: 'rate_limited' };
  }
  try {
    const input = { ...parsed.data, deviceToken: opts.deviceToken };
    return { ok: true, user: await identity.verifyCredentials(await requestAuthCtx(), input) };
  } catch (err) {
    if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') return { ok: false, code: 'invalid' };
    if (isAppError(err) && err.code === 'EMAIL_NOT_VERIFIED') return { ok: false, code: 'unverified' };
    throw err;
  }
}
