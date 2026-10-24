import { TwoFactorCode } from '@inmolink/contracts';
import { authCtx, closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey, totpCode, totpStep } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * Data export routes over HTTP (S10-08): create (Idempotency-Key), list, get — a link only with download=1. Since S11-F14 a
 * request also carries a fresh second-factor code, checked server-side.
 */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (sub: string, agency: string) => ({
  authorization: `Bearer ${(await signer.sign({ sub, aud: 'api', sv: 1, agency })).token}`,
});

const build = () =>
  buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allowAll,
    readinessCacheMs: 0,
    checks: { db: () => pingDb('app_user') },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) }),
  });

let app: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  await setupTestDb('http');
  identity.configureIdentity({
    hmacKey: 'test-hmac-key-0123456789abcdef0123456789',
    keyring: createKeyring({ keys: { t1: generateKey() }, activeKeyId: 't1' }),
  });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

const PASSWORD = 'correct horse battery'; // createFounder's

/**
 * A founder with an authenticator app. `codes()` yields one usable code per call: the current TOTP first, then the
 * recovery codes (a TOTP step is single-use, so several requests in one second need distinct codes).
 */
async function founderWithAuthenticator(role?: 'AGENT') {
  const f = await createFounder();
  if (role) {
    await adminQuery('update agency_members set role = $1 where user_id = $2', [role, f.userId]);
  }
  const { secret } = await identity.startEnrolment(authCtx(newId()), { userId: f.userId, password: PASSWORD });
  const done = await identity.confirmEnrolment(authCtx(newId()), {
    userId: f.userId,
    sessionVersion: 1,
    code: totpCode(secret, totpStep(new Date())),
  });
  const recovery = [...done.recoveryCodes];
  // the enrolment consumed the current step: the next one is accepted within the drift window
  const totp = [totpCode(secret, totpStep(new Date()) + 1)];
  return { ...f, secret, code: () => TwoFactorCode.parse(totp.shift() ?? recovery.shift()) };
}

describe('data export routes', () => {
  it('[S11-F14] an export without a fresh second-factor code is refused, a wrong code too, nothing is queued; a created export spends the code', async () => {
    const f = await founderWithAuthenticator();
    const headers = await bearer(f.userId, f.agencyId);
    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/v1/agency/data-exports', headers, payload: payload as object });

    const missing = await post({ kind: 'CONTACTS' });
    expect(missing.statusCode).toBe(422);
    const wrong = await post({ kind: 'CONTACTS', twoFactorCode: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('MFA_CODE_INVALID');
    const none = await app.inject({
      method: 'GET',
      url: '/v1/agency/data-exports',
      headers,
    });
    expect(none.json().items).toHaveLength(0);

    const code = f.code();
    const ok = await post({ kind: 'CONTACTS', twoFactorCode: code });
    expect(ok.statusCode).toBe(201);
    // a created export spent the code: it is single-use
    await expect(
      identity.verifyStepUp(authCtx(newId()), { userId: f.userId, code, unlocks: { action: 'test' } }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
  });

  it('[S11-F14] a replay with the same Idempotency-Key and the same code answers 200 without a new check', async () => {
    const f = await founderWithAuthenticator();
    const headers = { ...(await bearer(f.userId, f.agencyId)), 'idempotency-key': `dx-${newId()}` };
    const code = f.code();
    const payload = { kind: 'CONTACTS', twoFactorCode: code };
    const first = await app.inject({ method: 'POST', url: '/v1/agency/data-exports', headers, payload });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/v1/agency/data-exports', headers, payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it('[S11-F14] a non-admin is FORBIDDEN and the code is not spent', async () => {
    const f = await founderWithAuthenticator('AGENT');
    const code = f.code();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers: await bearer(f.userId, f.agencyId),
      payload: { kind: 'CONTACTS', twoFactorCode: code },
    });
    expect(res.statusCode).toBe(403);
    // the code still works: the check never ran
    await expect(
      identity.verifyStepUp(authCtx(newId()), { userId: f.userId, code, unlocks: { action: 'test' } }),
    ).resolves.toBeUndefined();
  });

  it('[S11-F14] a running export answers 409 and the code is not spent', async () => {
    const f = await founderWithAuthenticator();
    const headers = await bearer(f.userId, f.agencyId);
    const post = (code: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/agency/data-exports',
        headers,
        payload: { kind: 'LEADS', twoFactorCode: code },
      });
    expect((await post(f.code())).statusCode).toBe(201);
    const code = f.code();
    const busy = await post(code);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('DATA_EXPORT_IN_PROGRESS');
    await expect(
      identity.verifyStepUp(authCtx(newId()), { userId: f.userId, code, unlocks: { action: 'test' } }),
    ).resolves.toBeUndefined();
  });

  it('[S11-F14] a user without 2FA enabled cannot export (no code can be valid)', async () => {
    const f = await createFounder();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers: await bearer(f.userId, f.agencyId),
      payload: { kind: 'CONTACTS', twoFactorCode: '123456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MFA_CODE_INVALID');
  });

  it('[S10-08] POST queues an export (201), a retry with the Idempotency-Key replays it (200), a second export waits (409)', async () => {
    const f = await founderWithAuthenticator();
    const headers = { ...(await bearer(f.userId, f.agencyId)), 'idempotency-key': `dx-${newId()}` };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers,
      payload: { kind: 'CONTACTS', format: 'xlsx', twoFactorCode: f.code() },
    });
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(created).toMatchObject({ kind: 'CONTACTS', format: 'xlsx', status: 'QUEUED', download: null });

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers,
      payload: { kind: 'CONTACTS', format: 'xlsx', twoFactorCode: f.code() },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(created.id);

    const other = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers: await bearer(f.userId, f.agencyId),
      payload: { kind: 'LEADS', twoFactorCode: f.code() },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('DATA_EXPORT_IN_PROGRESS');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/agency/data-exports',
      headers: await bearer(f.userId, f.agencyId),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((e: { id: string }) => e.id)).toContain(created.id);

    const one = await app.inject({
      method: 'GET',
      url: `/v1/agency/data-exports/${created.id}?download=1`,
      headers: await bearer(f.userId, f.agencyId),
    });
    expect(one.statusCode).toBe(200);
    expect(one.headers['cache-control']).toBe('no-store');
    // not finished yet: no link
    expect(one.json()).toMatchObject({ id: created.id, status: 'QUEUED', download: null });
  });

  it('[S10-08] another agency gets 404 and a bad body 422', async () => {
    const [a, b] = await Promise.all([founderWithAuthenticator(), createFounder()]);
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agency/data-exports',
        headers: await bearer(a.userId, a.agencyId),
        payload: { kind: 'LISTINGS', twoFactorCode: a.code() },
      })
    ).json();
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/agency/data-exports/${created.id}`,
      headers: await bearer(b.userId, b.agencyId),
    });
    expect(foreign.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers: await bearer(b.userId, b.agencyId),
      payload: { kind: 'EVERYTHING', twoFactorCode: '123456' },
    });
    expect(bad.statusCode).toBe(422);
  });
});
