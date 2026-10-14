import { clientIpFromForwarded } from '@inmolink/platform/http';
import { ipBucket, type RateLimiter, type RateLimitRule, rateLimiter } from '@inmolink/platform/rate-limit';
import { webConfig } from './env';

/**
 * Auth rate limits (PLAN §12 "per-IP and per-email"). Credential rules fail closed when Redis is down
 * (`auth.*` / `password.*` names, S0-07). Values are working figures; tune from login telemetry.
 */
export const LIMITS = {
  loginIp: { name: 'auth.login.ip', scope: 'ip', limit: 30, windowSeconds: 15 * 60, failClosed: true },
  /**
   * Per email from one client (identity `email|ipBucket`): guessing one account is slow, but nobody
   * can lock its owner out from elsewhere. `loginEmail` is the ceiling against distributed guessing:
   * past it each attempt needs a solved Turnstile challenge (S1-F5; a hard block when Turnstile is not
   * configured). `loginEmailDay` is the hard cap behind it, against paid captcha solving at scale.
   */
  loginEmailIp: { name: 'auth.login.email-ip', scope: 'email', limit: 10, windowSeconds: 15 * 60, failClosed: true },
  loginEmail: { name: 'auth.login.email', scope: 'email', limit: 100, windowSeconds: 60 * 60, failClosed: true },
  loginEmailDay: {
    name: 'auth.login.email-day',
    scope: 'email',
    limit: 1_000,
    windowSeconds: 24 * 60 * 60,
    failClosed: true,
  },
  signupIp: { name: 'auth.signup.ip', scope: 'ip', limit: 10, windowSeconds: 60 * 60, failClosed: true },
  /** Each sign-up emails the address (confirmation or "account exists"): cap mail to one inbox. */
  signupEmail: { name: 'auth.signup.email', scope: 'email', limit: 3, windowSeconds: 60 * 60, failClosed: true },
  verifyIp: { name: 'auth.verify.ip', scope: 'ip', limit: 30, windowSeconds: 60 * 60, failClosed: true },
  resetRequestIp: { name: 'password.request.ip', scope: 'ip', limit: 10, windowSeconds: 60 * 60, failClosed: true },
  resetRequestEmail: {
    name: 'password.request.email',
    scope: 'email',
    limit: 3,
    windowSeconds: 60 * 60,
    failClosed: true,
  },
  resetSubmitIp: { name: 'password.reset.ip', scope: 'ip', limit: 20, windowSeconds: 60 * 60, failClosed: true },
  inviteAcceptIp: { name: 'invite.accept.ip', scope: 'ip', limit: 20, windowSeconds: 60 * 60, failClosed: true },
  /**
   * Second-factor checks (S1-04; challenge, enrolment password and code, new recovery codes and turning
   * 2FA off share these buckets), counted before any check. Keyed by user **and** client (S1-F8, like
   * `loginEmailIp`): 5 per 5 minutes leaves one client who already has the password about one chance in
   * 70,000 per window against 3 valid TOTP codes, and burning them locks out that client only — the
   * owner, from another network, is not in the same bucket.
   */
  mfaUserIp: { name: 'auth.mfa.user-ip', scope: 'user', limit: 5, windowSeconds: 5 * 60, failClosed: true },
  /** Daily ceiling per user and client (security review M1): a slow, steady guesser stops at 20 a day. */
  mfaUserIpDay: {
    name: 'auth.mfa.user-ip-day',
    scope: 'user',
    limit: 20,
    windowSeconds: 24 * 60 * 60,
    failClosed: true,
  },
  /**
   * Ceiling for one user across all clients, against guessing spread over many networks: 200 a day is
   * 0.06% odds per day, and takes at least ten networks to reach (each is held to 20). Past it the owner
   * waits for the window — the cost of not letting one client lock the owner out earlier.
   */
  mfaUserDay: { name: 'auth.mfa.user-day', scope: 'user', limit: 200, windowSeconds: 24 * 60 * 60, failClosed: true },
  mfaIp: { name: 'auth.mfa.ip', scope: 'ip', limit: 30, windowSeconds: 15 * 60, failClosed: true },
  tokenUser: { name: 'session.token.user', scope: 'user', limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/** Requests without a usable client address share one bucket (fails safe, never unlimited). */
const UNKNOWN_IP = 'unknown';

export async function clientIp(forwardedFor: string | null): Promise<string> {
  const { TRUST_PROXY } = await webConfig();
  const ip = clientIpFromForwarded(forwardedFor, TRUST_PROXY);
  return ip ? ipBucket(ip) : UNKNOWN_IP;
}

/**
 * Counts every check (all rules see the attempt) and returns the longest wait, or 0 when allowed.
 * `limiter` is injectable for tests.
 */
export async function checkLimits(
  checks: readonly [RateLimitRule, string][],
  limiter: RateLimiter = rateLimiter(),
): Promise<number> {
  const results = await Promise.all(checks.map(([rule, identity]) => limiter.consume(rule, identity)));
  return Math.max(0, ...results.filter((r) => !r.allowed).map((r) => r.retryAfterSeconds));
}
