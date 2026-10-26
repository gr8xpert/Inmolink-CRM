import { closeDb, pingDb } from '@inmolink/core';
import { createFounder } from '@inmolink/core/test';
import { createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import {
  createAccessTokenSigner,
  createAccessTokenVerifier,
  generateAccessKeyPair,
  parsePublicKeys,
  privateKeyFromBase64,
} from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** Legacy migration validation reports over HTTP (S14-03): staff only, any staff role, read only. */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (sub: string, agency?: string) => ({
  authorization: `Bearer ${(await signer.sign({ sub, aud: 'api', sv: 1, ...(agency ? { agency } : {}) })).token}`,
});

const log = createLogger({ level: 'silent' });
const build = () =>
  buildApp({
    logger: log,
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
  await configureQueue({ prefix: `test-api-staff-migration-${newId().slice(-8)}`, logger: log });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeQueues();
  await closeDb();
});

describe('staff migration validation API (S14-03)', () => {
  it('[S14-03] staff list and open validation reports; tenants and non-staff users get 403', async () => {
    const f = await createFounder();
    const routes = ['/v1/staff/migration/validations', `/v1/staff/migration/validations/${newId()}`];
    for (const headers of [await bearer(f.userId, f.agencyId), await bearer(newId())]) {
      for (const url of routes) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, url).toBe(403);
      }
    }
    const support = await createStaffUser('STAFF_SUPPORT');
    const headers = await bearer(support.userId);
    const list = await app.inject({ method: 'GET', url: '/v1/staff/migration/validations?status=FAIL', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: expect.any(Array) });
    const missing = await app.inject({ method: 'GET', url: `/v1/staff/migration/validations/${newId()}`, headers });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/v1/staff/migration/validations?status=MAYBE', headers });
    expect(bad.statusCode).toBe(422);
  });
});
