import { closeDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
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

/** API key management over HTTP (S1-05): agency admins create, list, rotate and revoke keys. */

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
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

const WIDGET = {
  name: 'Search widget',
  kind: 'PUBLISHABLE',
  scopes: ['listings:read'],
  allowedOrigins: ['https://www.costa-homes.example'],
};

describe('API key routes', () => {
  it('[S1-05] secret is shown once; admins create, list, rotate and revoke keys', async () => {
    const f = await createFounder();
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    const headers = await bearer(f.userId, f.agencyId);

    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers, payload: WIDGET });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const { key, secret } = created.json() as { key: { id: string; prefix: string }; secret: string };
    expect(secret).toMatch(/^inl_test_pk[a-z2-7]{10}_[a-z2-7]{52}$/);

    const list = await app.inject({ method: 'GET', url: '/v1/api-keys', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({ id: key.id, prefix: key.prefix, kind: 'PUBLISHABLE', status: 'ACTIVE' }),
    ]);
    expect(list.body).not.toContain(secret.split('_').at(-1));
    expect(list.body).not.toContain('keyHash');

    const rotated = await app.inject({ method: 'POST', url: `/v1/api-keys/${key.id}/rotate`, headers });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(rotated.json().secret).not.toBe(secret);

    expect((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${key.id}`, headers })).statusCode).toBe(204);
    const again = await app.inject({ method: 'DELETE', url: `/v1/api-keys/${key.id}`, headers });
    expect(again.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/api-keys', headers })).json().items[0].status).toBe('REVOKED');
  });

  it('[S1-05] creating a key needs a verified agency', async () => {
    const f = await createFounder();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: await bearer(f.userId, f.agencyId),
      payload: WIDGET,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
  });

  it('[S1-05] a publishable key without an allowed origin is refused', async () => {
    const f = await createFounder();
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: await bearer(f.userId, f.agencyId),
      payload: { ...WIDGET, allowedOrigins: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});
