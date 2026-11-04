import { randomBytes } from 'node:crypto';
import { closeDb } from '@inmolink/db';
import { loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createAccessTokenSigner, generateAccessKeyPair, privateKeyFromBase64 } from '@inmolink/platform/jwt';
import { closeRateLimit, configureRateLimit, rateLimitConnection } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authCtx } from '../../../context';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../index';

/**
 * S17-F32: logging out ends that session: a copy of its cookie opens no page (the `jwt` callback's check) and mints no
 * access token, at once. The user's other sessions stay signed in, and an unreachable Redis fails open.
 */

const pair = generateAccessKeyPair();
const auth = () => authCtx(newId());
const sid = () => randomBytes(18).toString('base64url');

const mint = (m: Founder, sessionId?: string, audience: 'api' | 'realtime' = 'api') =>
  identity.issueAccessToken(auth(), {
    userId: m.userId,
    sessionVersion: 1,
    mfaVerified: true,
    audience,
    ...(sessionId ? { sessionId } : {}),
  });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

const useLimitsRedis = () => configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    webUrl: 'http://web.test',
    signer: createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' }),
  });
  await useLimitsRedis();
}, 120_000);

afterAll(async () => {
  await closeRateLimit();
  await closeDb();
});

describe('logging out', () => {
  it('[S17-F32] a logged-out session is refused at mint, for every audience, straight away', async () => {
    const m = await createFounder();
    const sessionId = sid();
    expect(await refusal(mint(m, sessionId))).toBe('accepted');
    expect(await identity.revokeWebSession({ userId: m.userId, sessionId })).toBe(true);
    expect(await refusal(mint(m, sessionId))).toBe('SESSION_REVOKED');
    expect(await refusal(mint(m, sessionId, 'realtime'))).toBe('SESSION_REVOKED');
  });

  it('[S17-F32] a logged-out session cannot start an impersonation token either', async () => {
    const m = await createFounder();
    const sessionId = sid();
    await identity.revokeWebSession({ userId: m.userId, sessionId });
    const minted = identity.issueAccessToken(auth(), {
      userId: m.userId,
      sessionVersion: 1,
      mfaVerified: true,
      audience: 'api',
      impersonationId: newId(),
      sessionId,
    });
    expect(await refusal(minted)).toBe('SESSION_REVOKED');
  });

  it('[S17-F32] a logged-out session is refused at page level (the jwt callback ends it)', async () => {
    const m = await createFounder();
    const sessionId = sid();
    expect(await identity.isWebSessionLive(sessionId)).toBe(true);
    await identity.revokeWebSession({ userId: m.userId, sessionId });
    expect(await identity.isWebSessionLive(sessionId)).toBe(false);
  });

  it('[S17-F32] another session of the same user stays signed in, with the same session version', async () => {
    const m = await createFounder();
    const [loggedOut, otherDevice] = [sid(), sid()];
    await identity.revokeWebSession({ userId: m.userId, sessionId: loggedOut });
    expect(await identity.isWebSessionLive(otherDevice)).toBe(true);
    expect(await refusal(mint(m, otherDevice))).toBe('accepted');
    expect(await identity.isSessionValid(auth(), { userId: m.userId, sessionVersion: 1 })).toBe(true);
  });

  it('[S17-F32] a new login after the logout is a new session and works', async () => {
    const m = await createFounder();
    await identity.revokeWebSession({ userId: m.userId, sessionId: sid() });
    const login = sid();
    expect(await identity.isWebSessionLive(login)).toBe(true);
    expect(await refusal(mint(m, login))).toBe('accepted');
  });

  it('[S17-F32] the revocation lasts as long as any copy of the cookie can live, then goes', async () => {
    const m = await createFounder();
    const sessionId = sid();
    await identity.revokeWebSession({ userId: m.userId, sessionId });
    const ttl = await rateLimitConnection().ttl(`inl:cm:revoked:${sessionId}`);
    expect(ttl).toBeGreaterThan(identity.WEB_SESSION_MAX_AGE_SECONDS);
    expect(ttl).toBeLessThanOrEqual(identity.WEB_SESSION_REVOCATION_TTL_SECONDS);
  });
});

describe('the Client Mode PIN lockout', () => {
  it('[S17-F32] a session whose Client Mode is gone is locked, and a copy of its cookie is refused too', async () => {
    const m = await createFounder();
    const sessionId = sid();
    const state = { n: randomBytes(18).toString('base64url') };
    const result = await identity.checkClientModePin(auth(), { userId: m.userId, sessionId, state, pin: '4821' });
    expect(result).toBe('locked');
    expect(await identity.isWebSessionLive(sessionId)).toBe(false);
    expect(await refusal(mint(m, sessionId))).toBe('SESSION_REVOKED');
  });
});

describe('sessions without an id', () => {
  it('[S17-F32] a token without a sid is ended at page level: it could never be revoked', async () => {
    expect(await identity.isWebSessionLive(undefined)).toBe(false);
    expect(await identity.isWebSessionLive(null)).toBe(false);
    expect(await identity.isWebSessionLive(12345)).toBe(false);
    expect(await identity.isWebSessionLive('too-short')).toBe(false);
  });

  it('[S17-F32] a mint with no session id (no web session behind it) is not refused', async () => {
    const m = await createFounder();
    expect(await identity.isWebSessionRevoked(undefined)).toBe(false);
    expect(await refusal(mint(m))).toBe('accepted');
  });

  it('[S17-F32] a malformed id records nothing', async () => {
    expect(await identity.revokeWebSession({ userId: newId(), sessionId: 'bad id' })).toBe(false);
  });
});

describe('Redis unreachable', () => {
  it('[S17-F32] fails open like Client Mode at a mint; the logout reports it did not record', async () => {
    const m = await createFounder();
    const sessionId = sid();
    await configureRateLimit({ url: 'redis://127.0.0.1:1', commandTimeoutMs: 100 });
    try {
      expect(await identity.revokeWebSession({ userId: m.userId, sessionId })).toBe(false);
      expect(await identity.isWebSessionRevoked(sessionId)).toBe(false);
      expect(await identity.isWebSessionLive(sessionId)).toBe(true);
      expect(await refusal(mint(m, sessionId))).toBe('accepted');
    } finally {
      await useLimitsRedis();
    }
  }, 15_000);
});
