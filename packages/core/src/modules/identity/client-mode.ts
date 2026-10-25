import { randomBytes } from 'node:crypto';
import type { StartClientModeBody, StartClientModeDto } from '@inmolink/contracts';
import { setAuthScope } from '@inmolink/db';
import { whenReady } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { hmacSha256, safeEqual } from '@inmolink/platform/crypto';
import { hashPassword, verifyPassword } from '@inmolink/platform/crypto/password';
import { AppError } from '@inmolink/platform/errors';
import { type RateLimitRule, rateLimitConnection, rateLimiter } from '@inmolink/platform/rate-limit';
import type { AuthCtx, Ctx } from '../../context';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import { identityConfig } from './config';
import { identityLog } from './log';
import { assertCan } from './policy';
import * as repo from './repo';
import { forgetRememberedBrowsers } from './two-factor';

/**
 * Client Mode (S12-06, PLAN §3 #56): the agent shows the dashboard to a buyer. Every access token minted for a
 * session in Client Mode carries `cm`, and the API answers as `ctx.clientMode` (policies refuse all but a few reads;
 * their serializers drop commission, owner agency, internal notes and private fields; the API's response net catches
 * what a serializer forgets).
 *
 * State (S12-06 security review): the web session cookie only names this Client Mode (`n`, a nonce). What decides is
 * kept **server-side** on the limits Redis (never evicting), for at most `CLIENT_MODE_TTL_SECONDS`:
 * - `n:<nonce>` — the member, the PIN's Argon2id hash, the attempt limit and whether it is still active;
 * - `s:<sessionId>` — the Client Mode a web session is in: every mint of that session carries `cm`, so an older copy of
 *   the cookie (from before Client Mode) or another tab cannot mint without it;
 * - `u:<userId>` — the member's active Client Mode: a new login (the buyer signed out, the saved password signed back
 *   in) starts in it again. The PIN is the only way out; after `CLIENT_MODE_TTL_SECONDS` it ends by itself.
 *
 * - **Enter** (`startClientMode`, `POST /v1/session/client-mode`, tenant ctx): a PIN of the agency's minimum length;
 *   its hash, the agency's attempt limit and a fresh nonce go back as a short-lived proof signed with the identity
 *   HMAC key. The web session callback activates it (`activateClientMode`) — once: a used nonce is refused.
 * - **Exit** (`checkClientModePin`, app_auth, from the web session callback): the nonce's attempt budget is taken
 *   **before** the PIN is checked (parallel submits cannot outnumber it), then the per-user rate limit (fail closed);
 *   wrong and throttled PINs are audited. The wrong PIN that uses up the budget ends the session and forgets the
 *   member's remembered browsers (the next login needs the second factor again); the next login is still in Client
 *   Mode, with no attempts left until the budget's window has passed.
 */

/** How long a start proof is valid: the web hands it to the session at once. */
export const CLIENT_MODE_PROOF_TTL_MS = 2 * 60_000;
/** A Client Mode ends by itself after this long (a forgotten PIN costs at most a day). */
export const CLIENT_MODE_TTL_SECONDS = 24 * 60 * 60;
/** The window of a Client Mode's attempt budget (the agency's `pinMaxAttempts`). */
export const CLIENT_MODE_ATTEMPTS_WINDOW_SECONDS = 60 * 60;

/** PIN checks per user (any client): slows guessing across sessions and logins. */
export const CLIENT_MODE_PIN_LIMITS = {
  user: { name: 'auth.client-mode.pin.user', scope: 'user', limit: 5, windowSeconds: 5 * 60, failClosed: true },
  userDay: {
    name: 'auth.client-mode.pin.user-day',
    scope: 'user',
    limit: 30,
    windowSeconds: 24 * 60 * 60,
    failClosed: true,
  },
} as const satisfies Record<string, RateLimitRule>;

function attemptsRule(maxAttempts: number): RateLimitRule {
  return {
    name: 'auth.client-mode.attempts',
    scope: 'user',
    limit: maxAttempts,
    windowSeconds: CLIENT_MODE_ATTEMPTS_WINDOW_SECONDS,
    failClosed: true,
  };
}

/** What the web session cookie keeps while in Client Mode: the nonce only (the rest is server-side). */
export interface ClientModeState {
  n: string;
}

interface NonceState {
  /** The member. */
  u: string;
  /** Argon2id hash of the PIN. */
  h: string;
  /** Wrong PINs before the session ends. */
  m: number;
  active: boolean;
}

interface ProofPayload {
  u: string;
  h: string;
  n: string;
  m: number;
  /** Expiry, epoch ms. */
  e: number;
}

const PREFIX = 'inl:cm';
const kNonce = (n: string) => `${PREFIX}:n:${n}`;
const kSession = (sid: string) => `${PREFIX}:s:${sid}`;
const kUser = (userId: string) => `${PREFIX}:u:${userId}`;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The limits Redis (never evicting), once it is ready (no offline queue: the first command would fail). */
async function limits() {
  const redis = rateLimitConnection();
  await whenReady(redis);
  return redis;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const macOf = (payload: string) => hmacSha256(identityConfig().hmacKey, 'client-mode-start', payload);

async function readNonce(n: string): Promise<NonceState | null> {
  if (!NONCE_RE.test(n)) return null;
  const raw = await (await limits()).get(kNonce(n));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as NonceState;
    return typeof v.u === 'string' && typeof v.h === 'string' && Number.isInteger(v.m) ? v : null;
  } catch {
    return null;
  }
}

/** Enter Client Mode: checks the PIN against the agency's policy and returns the signed hand-over for the session. */
export async function startClientMode(ctx: Ctx, input: StartClientModeBody): Promise<StartClientModeDto> {
  assertCan(ctx, 'identity.clientMode.enter');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  const policy = await agencies.getClientModePolicy(ctx);
  if (input.pin.length < policy.pinMinLength) {
    throw new AppError('VALIDATION_FAILED', { field: 'pin', minLength: policy.pinMinLength });
  }
  const now = clock.now().getTime();
  const payload: ProofPayload = {
    u: ctx.actor.userId,
    h: await hashPassword(input.pin),
    n: randomBytes(18).toString('base64url'),
    m: policy.pinMaxAttempts,
    e: now + CLIENT_MODE_PROOF_TTL_MS,
  };
  const encoded = b64(JSON.stringify(payload));
  await compliance.audit(ctx, 'identity.clientMode.started', { type: 'user', id: ctx.actor.userId });
  return { proof: `${encoded}.${macOf(encoded)}`, expiresAt: new Date(payload.e).toISOString() };
}

/** A start proof's content when it is genuine, unexpired and the member's own (no state is read or written). */
export function openClientModeProof(input: { userId: string; proof: unknown }): ProofPayload | null {
  if (typeof input.proof !== 'string' || input.proof.length > 2_000) return null;
  const [encoded, mac, extra] = input.proof.split('.');
  if (!encoded || !mac || extra !== undefined || !safeEqual(macOf(encoded), mac)) return null;
  let payload: ProofPayload;
  try {
    payload = JSON.parse(unb64(encoded)) as ProofPayload;
  } catch {
    return null;
  }
  const now = clock.now().getTime();
  if (payload.u !== input.userId || typeof payload.e !== 'number' || payload.e <= now) return null;
  if (payload.e > now + CLIENT_MODE_PROOF_TTL_MS) return null;
  if (typeof payload.h !== 'string' || typeof payload.n !== 'string' || !NONCE_RE.test(payload.n)) return null;
  if (!Number.isInteger(payload.m) || payload.m < 1) return null;
  return payload;
}

/**
 * The session callback's start: a genuine proof activates its Client Mode for this web session and the member —
 * once (a replayed proof finds its nonce taken). Returns the cookie's state, or null.
 */
export async function activateClientMode(input: {
  userId: string;
  sessionId: string;
  proof: unknown;
}): Promise<ClientModeState | null> {
  const p = openClientModeProof(input);
  if (!p || !SID_RE.test(input.sessionId)) return null;
  const redis = await limits();
  const state: NonceState = { u: p.u, h: p.h, m: p.m, active: true };
  const taken = await redis.set(kNonce(p.n), JSON.stringify(state), 'EX', CLIENT_MODE_TTL_SECONDS, 'NX');
  if (taken !== 'OK') return null;
  await redis
    .multi()
    .set(kSession(input.sessionId), p.n, 'EX', CLIENT_MODE_TTL_SECONDS)
    .set(kUser(input.userId), p.n, 'EX', CLIENT_MODE_TTL_SECONDS)
    .exec();
  return { n: p.n };
}

/**
 * A new web session (login) of a member with an active Client Mode starts in it (the buyer cannot sign out and back
 * in with the saved password to leave it). Returns the cookie's state, or null.
 */
export async function clientModeAtLogin(input: { userId: string; sessionId: string }): Promise<ClientModeState | null> {
  if (!SID_RE.test(input.sessionId)) return null;
  const redis = await limits();
  const n = await redis.get(kUser(input.userId));
  if (!n) return null;
  const state = await readNonce(n);
  if (!state?.active || state.u !== input.userId) return null;
  await redis.set(kSession(input.sessionId), n, 'EX', CLIENT_MODE_TTL_SECONDS);
  return { n };
}

/**
 * Whether a mint must carry `cm` (`issueAccessToken`): the web session's own Client Mode, server-side — whatever its
 * cookie says. A session without an id (from before S12-06) follows the member's active Client Mode.
 */
export async function activeClientModeOf(input: {
  userId: string;
  sessionId?: string | null;
}): Promise<ClientModeState | null> {
  const redis = await limits();
  const n =
    input.sessionId && SID_RE.test(input.sessionId)
      ? await redis.get(kSession(input.sessionId))
      : await redis.get(kUser(input.userId));
  if (!n) return null;
  const state = await readNonce(n);
  return state?.active === true && state.u === input.userId ? { n } : null;
}

/** A well-formed state from the session cookie. */
export function isClientModeState(value: unknown): value is ClientModeState {
  const v = value as Partial<ClientModeState> | null;
  return !!v && typeof v === 'object' && typeof v.n === 'string' && NONCE_RE.test(v.n);
}

/** `ok` ends Client Mode; `locked` ends the session (the budget is used up). */
export type ClientModePinResult = 'ok' | 'wrong' | 'rate_limited' | 'locked';

/**
 * The exit PIN (S12-06): the Client Mode's attempt budget first, then the per-user rate limit, then the hash.
 * Audited when wrong or throttled (`identity.clientMode.pinFailed`, never the PIN) and when it ends Client Mode
 * (`identity.clientMode.ended`). A Client Mode that is gone server-side (expired, unknown) ends the session.
 */
export async function checkClientModePin(
  ctx: AuthCtx,
  input: { userId: string; sessionId?: string | null; state: ClientModeState; pin: unknown },
): Promise<ClientModePinResult> {
  const n = input.state.n;
  const state = await readNonce(n);
  if (!state || state.u !== input.userId) {
    await auditPin(ctx, input.userId, 'identity.clientMode.pinFailed', { reason: 'unknown_client_mode' });
    return 'locked';
  }
  // Ended with its PIN in another tab or browser: this session is out of it too.
  if (!state.active) return 'ok';
  const limiter = rateLimiter();
  const attempts = await limiter.consume(attemptsRule(state.m), `${input.userId}:${n}`);
  if (!attempts.allowed) {
    await auditPin(ctx, input.userId, 'identity.clientMode.pinFailed', { reason: 'attempts_used_up' });
    return 'rate_limited';
  }
  const throttle = await limiter.consumeMany([
    { rule: CLIENT_MODE_PIN_LIMITS.user, identity: input.userId },
    { rule: CLIENT_MODE_PIN_LIMITS.userDay, identity: input.userId },
  ]);
  if (throttle.some((r) => !r.allowed)) {
    await auditPin(ctx, input.userId, 'identity.clientMode.pinFailed', { reason: 'rate_limited' });
    return 'rate_limited';
  }
  const pin = typeof input.pin === 'string' && /^\d{1,12}$/.test(input.pin) ? input.pin : null;
  if (pin && (await verifyPassword(state.h, pin))) {
    const redis = await limits();
    await redis
      .multi()
      .set(kNonce(n), JSON.stringify({ ...state, active: false }), 'KEEPTTL')
      .del(kUser(input.userId))
      .exec();
    if (input.sessionId && SID_RE.test(input.sessionId)) await redis.del(kSession(input.sessionId));
    await auditPin(ctx, input.userId, 'identity.clientMode.ended', {});
    return 'ok';
  }
  const locked = attempts.remaining === 0;
  await auditPin(ctx, input.userId, 'identity.clientMode.pinFailed', {
    reason: 'wrong',
    attemptsLeft: attempts.remaining,
    locked,
  });
  if (!locked) return 'wrong';
  // The budget is used up: the session ends, and the next login needs the second factor again (no remembered browser).
  await forgetRememberedBrowsers(ctx, { userId: input.userId });
  identityLog().warn({ userId: input.userId }, 'identity.clientMode.locked: session ended');
  return 'locked';
}

async function auditPin(
  ctx: AuthCtx,
  userId: string,
  type: 'identity.clientMode.pinFailed' | 'identity.clientMode.ended',
  metadata: compliance.AuditMetadata,
): Promise<void> {
  await ctx.transaction(async (tx) => {
    await setAuthScope(tx, { userId });
    const member = await repo.findMembership(tx, userId);
    await compliance.auditAuth(tx, {
      type,
      userId,
      agencyId: member?.agencyId ?? null,
      // Whoever typed a wrong PIN may be the client at the screen, not the member.
      authenticated: type === 'identity.clientMode.ended',
      requestId: ctx.requestId,
      metadata,
    });
  });
}
