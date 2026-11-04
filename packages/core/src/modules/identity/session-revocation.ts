import { whenReady } from '@inmolink/platform/cache';
import { rateLimitConnection } from '@inmolink/platform/rate-limit';
import { identityLog } from './log';

/**
 * Logging out ends that web session everywhere (S17-F32). The session is a JWT in a cookie, so clearing the cookie does
 * not stop a copy of it: `inl:cm:revoked:<sessionId>` on the limits Redis (never evicting) names a session that logged
 * out, and both the Auth.js `jwt` callback (`isWebSessionLive`: every `auth()`) and every mint (`issueAccessToken`)
 * refuse it. `session_version` stays as it is: the member's sessions on other devices stay signed in.
 *
 * - **Lifetime:** the longest any copy of the cookie can still live. A session is re-issued while in use, so a copy
 *   refreshed elsewhere can outlive the cookie that logged out, but a revoked session is not re-issued: every copy has
 *   expired `WEB_SESSION_MAX_AGE_SECONDS` later, and the margin covers a refresh in flight at the logout. The exception
 *   is a check that fails open (below): a copy refreshed during a Redis failure gets a new expiry that can outlast the
 *   entry, because sessions have no absolute age limit.
 * - **Key prefix:** under `inl:cm:*` on purpose: the `limits` ACL's selector for server-side state already allows GET /
 *   SET on it (S16-F11), so logout does not depend on an ACL rollout; a new prefix without one fails with NOPERM.
 * - **Redis unreachable: fails open, as Client Mode's state at a mint does (`serverClientMode`).** Every dashboard
 *   request and `auth()` passes here, so an outage must not sign everybody out; the session version, membership and 2FA
 *   checks still apply. A logout during an outage clears the cookie, logs the error and cannot refuse a copy of it.
 * - **Sessions without an id** (issued before S12-06, kept alive by rolling refresh) cannot be revoked one by one:
 *   `isWebSessionLive` ends them, so they log in again once. Mints without an id (`sessionId` is optional: scripts and
 *   services with no web session) are not refused here.
 */

/** Seven days: the Auth.js session's `maxAge`, and how long a revocation has to last. */
export const WEB_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** How long a revocation lasts: any copy's remaining life, plus a refresh in flight at the logout. */
export const WEB_SESSION_REVOCATION_TTL_SECONDS = WEB_SESSION_MAX_AGE_SECONDS + 60 * 60;

const PREFIX = 'inl:cm:revoked';
const kRevoked = (sessionId: string) => `${PREFIX}:${sessionId}`;
/** The web session's id (Auth.js token `sid`, 18 random bytes), as in client-mode.ts. */
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Held as `redis`: tests/adapters/limits-acl.int.test.ts checks each command here against the production ACL. */
async function limits() {
  const redis = rateLimitConnection();
  await whenReady(redis);
  return redis;
}

/**
 * Records that this web session logged out. Returns whether it was recorded; never throws, because a logout goes on to
 * clear the cookie whatever happens here.
 */
export async function revokeWebSession(input: { userId: string; sessionId: string }): Promise<boolean> {
  if (!SID_RE.test(input.sessionId)) return false;
  try {
    const redis = await limits();
    await redis.set(kRevoked(input.sessionId), '1', 'EX', WEB_SESSION_REVOCATION_TTL_SECONDS);
    return true;
  } catch (err) {
    identityLog().error({ err, userId: input.userId }, 'identity.session: logout not recorded (redis unreachable)');
    return false;
  }
}

/** Whether this web session logged out. One GET; Redis unreachable answers false (see above). */
export async function isWebSessionRevoked(sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId || !SID_RE.test(sessionId)) return false;
  try {
    const redis = await limits();
    return (await redis.get(kRevoked(sessionId))) !== null;
  } catch (err) {
    identityLog().warn({ err }, 'identity.session: revocation state unavailable');
    return false;
  }
}

/**
 * The Auth.js `jwt` callback's check of an existing session, from its token's `sid`: false ends the session (a logged-out
 * one, or one with no id, which could never be revoked).
 */
export async function isWebSessionLive(sessionId: unknown): Promise<boolean> {
  return typeof sessionId === 'string' && SID_RE.test(sessionId) && !(await isWebSessionRevoked(sessionId));
}
