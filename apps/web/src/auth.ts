import { randomBytes } from 'node:crypto';
import * as identity from '@inmolink/core/modules/identity';
import { createLogger } from '@inmolink/platform/logger';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { requestAuthCtx } from '@/server/request-id';
import { webConfig } from './server/env';
import { attemptLogin, type LoginFailure } from './server/login';
import { readCookie, rememberedDeviceCookie } from './server/two-factor';

/**
 * Auth.js v5 (PLAN §3 #30): email + password, JWT session in an encrypted, httpOnly, SameSite=Strict
 * cookie. The session never goes to the API — the API gets 15-minute access tokens minted from it
 * (`/session/token`), and every mint re-checks the user and `session_version`.
 *
 * Two-factor (S1-04): the session carries `mfa` — whether it passed the second factor. Login sets it
 * only for a remembered browser; afterwards only a server-signed proof from identity can set it
 * (a session update's data comes from the browser, so nothing else in it is trusted). Mints refuse
 * sessions without it when the user needs 2FA, and the pages send them to `/two-factor`.
 */
class LoginError extends CredentialsSignin {
  constructor(code: LoginFailure) {
    super();
    this.code = code;
  }
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      locale: string;
      sessionVersion: number;
      mfaVerified: boolean;
      /** S12-06: the session is in Client Mode (its PIN hash stays in the token, never in the session). */
      clientMode: boolean;
      /** S12-06: why the last exit PIN did not end Client Mode. */
      clientModeError?: 'wrong' | 'rate_limited';
      /** S12-06 review: this web session's id (server-side Client Mode state is kept per session). */
      sessionId?: string;
    };
    /** Only in `unstable_update` calls: proof that this session passed 2FA (checked by identity). */
    mfaProof?: string;
    /** S12-06, only in `unstable_update` calls: identity's signed hand-over that starts Client Mode. */
    clientModeProof?: string;
    /** S12-06, only in `unstable_update` calls: the PIN that ends Client Mode (checked by identity). */
    clientModePin?: string;
  }
  interface User {
    locale?: string;
    sessionVersion?: number;
    mfaVerified?: boolean;
  }
}

/** Seven days; the session is refreshed at most daily while in use. */
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** How stale the "user still active, session not revoked" check may get. */
const SESSION_RECHECK_MS = 5 * 60_000;
const logger = createLogger({ service: 'web' });

export const {
  handlers,
  auth,
  signIn,
  signOut,
  unstable_update: updateSession,
} = NextAuth(async () => {
  const config = await webConfig();
  const secure = config.WEB_URL.startsWith('https://');
  return {
    secret: config.AUTH_SECRET,
    // Auth.js derives its base URL from Host / X-Forwarded-Host; every redirect is pinned to WEB_URL below.
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS, updateAge: 24 * 60 * 60 },
    pages: { signIn: '/login' },
    logger: {
      error(error) {
        // Failed logins are expected traffic (counted by the rate limits), not server errors.
        const type = (error as { type?: string }).type;
        if (type === 'CredentialsSignin') return;
        logger.error({ type, err: error }, 'auth.js error');
      },
    },
    cookies: {
      sessionToken: {
        name: `${secure ? '__Secure-' : ''}authjs.session-token`,
        options: { httpOnly: true, sameSite: 'strict', path: '/', secure },
      },
    },
    providers: [
      Credentials({
        credentials: { email: {}, password: {}, turnstile: {} },
        async authorize(credentials, request) {
          const turnstile = (credentials as { turnstile?: unknown }).turnstile;
          const result = await attemptLogin(credentials, request.headers.get('x-forwarded-for'), {
            deviceToken: readCookie(request.headers.get('cookie'), rememberedDeviceCookie(secure).name),
            turnstileToken: typeof turnstile === 'string' && turnstile !== '' ? turnstile : undefined,
          });
          if (!result.ok) throw new LoginError(result.code);
          const u = result.user;
          return {
            id: u.id,
            email: u.email,
            name: u.name,
            locale: u.locale,
            sessionVersion: u.sessionVersion,
            mfaVerified: u.mfaVerified,
          };
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user, trigger, session }) {
        const now = Date.now();
        if (user) {
          token.sub = user.id;
          token.locale = user.locale;
          token.sv = user.sessionVersion;
          token.mfa = user.mfaVerified === true;
          token.checkedAt = now;
          // S12-06 review: the session's id (server-side Client Mode is kept per session), and a member whose Client
          // Mode is still on starts this new session in it (signing out and back in does not leave it).
          token.sid = randomBytes(18).toString('base64url');
          const resumed = await identity.clientModeAtLogin({
            userId: user.id as string,
            sessionId: token.sid as string,
          });
          if (resumed) token.cm = resumed;
          return token;
        }
        // Sessions from before S12-06 get their id on their next update.
        if (typeof token.sid !== 'string') token.sid = randomBytes(18).toString('base64url');
        // The browser can send any data with an update: only a valid identity proof upgrades the session.
        if (trigger === 'update') {
          const proof = (session as { mfaProof?: unknown } | undefined)?.mfaProof;
          if (identity.checkMfaProof({ userId: String(token.sub), sessionVersion: Number(token.sv), proof })) {
            token.mfa = true;
          }
          // S12-06: Client Mode starts only from identity's signed proof (once: a session in it ignores new ones) and
          // ends only with its PIN — rate-limited and audited by identity; too many wrong PINs end the session.
          const update = session as { clientModeProof?: unknown; clientModePin?: unknown } | undefined;
          const userId = String(token.sub);
          const sessionId = String(token.sid);
          // The server's state decides (S12-06 review): an older copy of this cookie may not say Client Mode.
          if (update?.clientModeProof !== undefined || update?.clientModePin !== undefined) {
            const active = await identity.activeClientModeOf({ userId, sessionId });
            if (active) token.cm = active;
          }
          if (!token.cm && update?.clientModeProof !== undefined) {
            const state = await identity.activateClientMode({ userId, sessionId, proof: update.clientModeProof });
            if (state) {
              token.cm = state;
              delete token.cmError;
            }
          } else if (identity.isClientModeState(token.cm) && update?.clientModePin !== undefined) {
            const result = await identity.checkClientModePin(await requestAuthCtx(), {
              userId,
              sessionId,
              state: token.cm,
              pin: update.clientModePin,
            });
            if (result === 'locked') return null;
            if (result === 'ok') {
              delete token.cm;
              delete token.cmError;
            } else token.cmError = result;
          }
        }
        // Every few minutes, end sessions revoked by a password reset or deactivation.
        if (now - Number(token.checkedAt ?? 0) > SESSION_RECHECK_MS) {
          const valid = await identity.isSessionValid(await requestAuthCtx(), {
            userId: String(token.sub),
            sessionVersion: Number(token.sv),
          });
          if (!valid) return null;
          token.checkedAt = now;
        }
        return token;
      },
      session({ session, token }) {
        Object.assign(session.user, {
          id: String(token.sub),
          email: String(token.email ?? ''),
          name: String(token.name ?? ''),
          locale: String(token.locale ?? ''),
          sessionVersion: Number(token.sv),
          mfaVerified: token.mfa === true,
          // S12-06: the flag only. Mints also follow the server-side state of `sessionId`, whatever this says.
          clientMode: token.cm !== undefined && token.cm !== null,
          sessionId: typeof token.sid === 'string' ? token.sid : undefined,
          ...(token.cmError === 'wrong' || token.cmError === 'rate_limited' ? { clientModeError: token.cmError } : {}),
        });
        return session;
      },
      // Only redirects to WEB_URL — never to the request's (header-derived) host.
      redirect({ url }) {
        const origin = new URL(config.WEB_URL).origin;
        if (url.startsWith('/') && !url.startsWith('//')) return `${origin}${url}`;
        try {
          return new URL(url).origin === origin ? url : origin;
        } catch {
          return origin;
        }
      },
    },
  };
});
