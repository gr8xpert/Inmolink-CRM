import { randomInt } from 'node:crypto';
import { authCtx, closeDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { totpCode, totpStep } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webConfig } from './env';
import { LIMITS } from './limits';
import { attemptChallenge, readCookie, withPasswordCheck } from './two-factor';

/** Second-factor limits against the real test stack (Postgres via app_auth, redis-cache counters). */

beforeAll(async () => {
  await setupTestDb('http'); // also loads .env.test(.example) into process.env
  await webConfig();
  // Counting, not latency (see login.int.test.ts).
  await configureCache({ url: process.env.REDIS_CACHE_URL, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
}, 120_000);

afterAll(async () => {
  await closeCache();
  await closeRateLimit();
  await closeDb();
});

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

/** An agency admin with 2FA enabled; returns the secret of their authenticator app. */
async function enrolledAdmin() {
  const founder = await createFounder();
  const { secret } = await identity.startEnrolment(authCtx(newId()), {
    userId: founder.userId,
    password: founder.password,
  });
  // The step before now: the challenge below can still use the current one.
  const code = totpCode(secret, totpStep(new Date()) - 1);
  await identity.confirmEnrolment(authCtx(newId()), { userId: founder.userId, sessionVersion: 1, code });
  return { session: { userId: founder.userId, sessionVersion: 1 }, secret };
}

describe('two-factor rate limits', () => {
  it('[S1-04] verification attempts are rate-limited per user and client: after the limit even the right code is refused', async () => {
    const { session, secret } = await enrolledAdmin();
    const ip = randomIp();
    for (let i = 0; i < LIMITS.mfaUserIp.limit; i++) {
      const r = await attemptChallenge(session, { code: '000000', rememberDevice: false, forwardedFor: ip });
      expect(r).toEqual({ ok: false, code: 'invalid' });
    }
    const right = totpCode(secret, totpStep(new Date()));
    expect(await attemptChallenge(session, { code: right, rememberDevice: false, forwardedFor: ip })).toEqual({
      ok: false,
      code: 'rate_limited',
    });
  }, 60_000);

  it('[S1-F8] someone with the password cannot lock the owner out: another client still passes the challenge', async () => {
    const { session, secret } = await enrolledAdmin();
    const attacker = randomIp();
    for (let i = 0; i < LIMITS.mfaUserIp.limit; i++) {
      await attemptChallenge(session, { code: '000000', rememberDevice: false, forwardedFor: attacker });
    }
    expect(await attemptChallenge(session, { code: '000000', rememberDevice: false, forwardedFor: attacker })).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    const owner = await attemptChallenge(session, {
      code: totpCode(secret, totpStep(new Date())),
      rememberDevice: false,
      forwardedFor: randomIp(),
    });
    expect(owner.ok).toBe(true);
  }, 60_000);

  it('[S1-F8] a password check before enrolment is counted in the same buckets', async () => {
    const founder = await createFounder();
    const ip = randomIp();
    const check = (password: string) =>
      withPasswordCheck({ userId: founder.userId, password, forwardedFor: ip }, async (p) =>
        identity.startEnrolment(authCtx(newId()), { userId: founder.userId, password: p }),
      );
    expect(await check('')).toEqual({ ok: false, code: 'input' });
    for (let i = 0; i < LIMITS.mfaUserIp.limit; i++)
      expect(await check('wrong password')).toEqual({ ok: false, code: 'password' });
    expect(await check(founder.password)).toEqual({ ok: false, code: 'rate_limited' });
    // Another client with the right password gets through.
    const other = await withPasswordCheck(
      { userId: founder.userId, password: founder.password, forwardedFor: randomIp() },
      async (p) => identity.startEnrolment(authCtx(newId()), { userId: founder.userId, password: p }),
    );
    expect(other.ok).toBe(true);
  }, 60_000);

  it('[S1-04] verification attempts are rate-limited per IP across users', async () => {
    const ip = randomIp();
    const users = await Promise.all(
      Array.from({ length: Math.ceil(LIMITS.mfaIp.limit / LIMITS.mfaUserIp.limit) }, () => createFounder()),
    );
    let attempts = 0;
    for (const user of users) {
      for (let i = 0; i < LIMITS.mfaUserIp.limit && attempts < LIMITS.mfaIp.limit; i++, attempts++) {
        const session = { userId: user.userId, sessionVersion: 1 };
        // Not enrolled: every code is invalid, but each attempt still counts.
        const r = await attemptChallenge(session, { code: '123456', rememberDevice: false, forwardedFor: ip });
        expect(r).toEqual({ ok: false, code: 'invalid' });
      }
    }
    const fresh = await createFounder();
    expect(
      await attemptChallenge(
        { userId: fresh.userId, sessionVersion: 1 },
        { code: '123456', rememberDevice: false, forwardedFor: ip },
      ),
    ).toEqual({ ok: false, code: 'rate_limited' });
  }, 120_000);

  it('[S1-04] a correct code passes and can remember the browser; malformed codes are refused first', async () => {
    const { session, secret } = await enrolledAdmin();
    expect(await attemptChallenge(session, { code: 'nope', rememberDevice: false, forwardedFor: randomIp() })).toEqual({
      ok: false,
      code: 'input',
    });
    const r = await attemptChallenge(session, {
      code: totpCode(secret, totpStep(new Date())),
      rememberDevice: true,
      forwardedFor: randomIp(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(identity.checkMfaProof({ ...session, proof: r.value.proof })).toBe(true);
    expect(r.value.device?.token).toMatch(/^\d{13}\.[A-Za-z0-9_-]{43}$/);
  }, 60_000);

  it('[S1-04] reads the remembered-browser cookie from a Cookie header', () => {
    expect(readCookie('a=1; inmolink.mfa-device=abc.def; b=2', 'inmolink.mfa-device')).toBe('abc.def');
    expect(readCookie('a=1', 'inmolink.mfa-device')).toBeUndefined();
    expect(readCookie(null, 'inmolink.mfa-device')).toBeUndefined();
  });
});
