import { closeDb, pingDb } from '@inmolink/core';
import * as search from '@inmolink/core/modules/search';
import { createFounder } from '@inmolink/core/test';
import { adminQuery, createStaffUser, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
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

/** Network search over HTTP (S5-05): the route, its body and response schemas, and the give-to-get gate. */

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

describe('network search route', () => {
  it('[S5-05] an agency below the threshold after grace gets the upsell state (200 LOCKED), not results', async () => {
    const f = await createFounder();
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    await adminQuery(`update agencies set created_at = now() - interval '60 days' where agency_id = $1`, [f.agencyId]);
    search.configureNetworkSearch({ giveToGetMinShared: 5, giveToGetGraceDays: 30 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/network/search',
      headers: await bearer(f.userId, f.agencyId),
      payload: { newBuilds: true, sort: 'price_asc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'LOCKED', gate: { state: 'LOCKED', sharedListings: 0, threshold: 5 } });
    expect(res.json()).not.toHaveProperty('items');

    // The body is validated; no session, no search.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/network/search',
      headers: await bearer(f.userId, f.agencyId),
      payload: { limit: 500 },
    });
    expect(bad.statusCode).toBe(422);
    const anon = await app.inject({ method: 'POST', url: '/v1/network/search', payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it('[S5-05] support staff exempt a buyer-only agency over HTTP; data ops are refused; an unknown agency is 404', async () => {
    const f = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const dataOps = await createStaffUser('STAFF_DATA_OPS');
    const put = async (staffUserId: string, agencyId: string, exempt: boolean) =>
      app.inject({
        method: 'PUT',
        url: `/v1/staff/agencies/${agencyId}/give-to-get`,
        headers: { authorization: `Bearer ${(await signer.sign({ sub: staffUserId, aud: 'api', sv: 1 })).token}` },
        payload: { exempt },
      });
    const ok = await put(support.userId, f.agencyId, true);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: f.agencyId, giveToGetExempt: true });
    expect((await put(dataOps.userId, f.agencyId, false)).statusCode).toBe(403);
    expect((await put(support.userId, newId(), true)).statusCode).toBe(404);
    // A tenant token is not staff.
    const tenant = await app.inject({
      method: 'PUT',
      url: `/v1/staff/agencies/${f.agencyId}/give-to-get`,
      headers: await bearer(f.userId, f.agencyId),
      payload: { exempt: false },
    });
    expect(tenant.statusCode).toBe(403);
  });
});
