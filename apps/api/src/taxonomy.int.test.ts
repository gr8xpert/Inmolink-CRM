import { TaxonomyDto } from '@inmolink/contracts';
import { closeDb, pingDb } from '@inmolink/core';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
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

/** Localized taxonomy for the dashboard over HTTP (S2-03). */

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
  await configureCache({ prefix: `t:taxonomy-api:${newId().slice(-12)}` });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

describe('taxonomy routes', () => {
  it('[S2-03] members read the localized taxonomy; anonymous callers are refused', async () => {
    const f = await createFounder();
    const res = await app.inject({ method: 'GET', url: '/v1/taxonomy', headers: await bearer(f.userId, f.agencyId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
    const body = TaxonomyDto.parse(res.json());
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const again = await app.inject({
      method: 'GET',
      url: '/v1/taxonomy',
      headers: { ...(await bearer(f.userId, f.agencyId)), 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(Array.isArray(body.locations) && Array.isArray(body.propertyTypes)).toBe(true);

    expect((await app.inject({ method: 'GET', url: '/v1/taxonomy' })).statusCode).toBe(401);
  });
});
