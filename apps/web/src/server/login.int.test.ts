import { randomInt } from 'node:crypto';
import { authCtx, closeDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache } from '@inmolink/platform/cache';
import { newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webConfig } from './env';
import { LIMITS } from './limits';
import { attemptLogin } from './login';

/** Login limits against the real test stack (Postgres via app_auth, redis-cache counters). */

beforeAll(async () => {
  await setupTestDb('http'); // also loads .env.test(.example) into process.env
  await webConfig();
}, 120_000);

afterAll(async () => {
  await closeCache();
  await closeDb();
});

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const uniqueEmail = () => `login-${newToken(6).toLowerCase()}@example.com`;

describe('login rate limits', () => {
  it('[S0-09] login is rate-limited per email: guessing from one client stops, the owner elsewhere is not locked out', async () => {
    const email = uniqueEmail();
    await identity.register(authCtx(newId()), { email, password: 'correct horse battery', name: 'Ana', locale: 'en' });
    const attacker = randomIp();
    for (let i = 0; i < LIMITS.loginEmailIp.limit; i++) {
      expect(await attemptLogin({ email, password: 'wrong password' }, attacker)).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
    expect(await attemptLogin({ email, password: 'correct horse battery' }, attacker)).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    // The owner from another network still reaches the password check (unverified account here).
    expect(await attemptLogin({ email, password: 'correct horse battery' }, randomIp())).toEqual({
      ok: false,
      code: 'unverified',
    });
  }, 60_000);

  it('[S0-09] login is rate-limited per email across many IPs (distributed guessing ceiling)', async () => {
    const email = uniqueEmail();
    for (let i = 0; i < LIMITS.loginEmail.limit; i++) {
      expect(await attemptLogin({ email, password: 'wrong password' }, randomIp())).toEqual({
        ok: false,
        code: 'invalid',
      });
    }
    expect(await attemptLogin({ email, password: 'wrong password' }, randomIp())).toEqual({
      ok: false,
      code: 'rate_limited',
    });
  }, 120_000);

  it('[S0-09] login is rate-limited per IP across different emails', async () => {
    const ip = randomIp();
    for (let i = 0; i < LIMITS.loginIp.limit; i++) {
      const r = await attemptLogin({ email: uniqueEmail(), password: 'whatever pw' }, ip);
      expect(r).toEqual({ ok: false, code: 'invalid' });
    }
    expect(await attemptLogin({ email: uniqueEmail(), password: 'whatever pw' }, ip)).toEqual({
      ok: false,
      code: 'rate_limited',
    });
    // Another client is unaffected.
    expect(await attemptLogin({ email: uniqueEmail(), password: 'whatever pw' }, randomIp())).toEqual({
      ok: false,
      code: 'invalid',
    });
  }, 60_000);

  it('[S0-09] malformed input is refused before any limit or password work', async () => {
    expect(await attemptLogin({ email: 'not-an-email', password: 'x' }, randomIp())).toEqual({
      ok: false,
      code: 'input',
    });
  });
});
