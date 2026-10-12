import { authCtx, closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
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

/** The agency's audit log over HTTP (S1-08). */

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
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('audit log route', () => {
  it('[S1-08] GET /v1/agency/audit-log returns the admin’s agency log, newest first, in keyset pages', async () => {
    const f = await createFounder();
    await expect(
      identity.verifyCredentials(authCtx(newId()), { email: f.email, password: 'wrong password!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await identity.verifyCredentials(authCtx(newId()), { email: f.email, password: f.password });
    const headers = await bearer(f.userId, f.agencyId);

    const first = await app.inject({ method: 'GET', url: '/v1/agency/audit-log?limit=1', headers });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page.items).toEqual([
      {
        id: expect.any(String),
        occurredAt: expect.any(String),
        type: 'identity.login.succeeded',
        actor: { kind: 'user', userId: f.userId, impersonated: false },
        target: { type: 'user', id: f.userId },
        requestId: expect.any(String),
        metadata: { secondFactor: 'required' },
      },
    ]);
    const next = await app.inject({
      method: 'GET',
      url: `/v1/agency/audit-log?limit=1&cursor=${page.nextCursor}`,
      headers,
    });
    expect(next.json().items.map((i: { type: string; metadata: unknown }) => [i.type, i.metadata])).toEqual([
      ['identity.login.failed', { reason: 'invalid_password' }],
    ]);
    expect(next.json().nextCursor).toBeNull();

    // Over the page cap, unauthenticated, or another agency's token: refused.
    expect((await app.inject({ method: 'GET', url: '/v1/agency/audit-log?limit=101', headers })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/v1/agency/audit-log' })).statusCode).toBe(401);
    const other = await createFounder();
    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/agency/audit-log',
      headers: await bearer(other.userId, other.agencyId),
    });
    expect(theirs.json().items).toEqual([]);
  });
});
