import { closeDb, pingDb } from '@inmolink/core';
import { createFounder } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
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

/** Preferred agencies and the agency directory over HTTP (S1-07). */

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

async function verified(companyName: string) {
  const f = await createFounder({ companyName });
  await setAgencyStatus(f.agencyId, 'VERIFIED');
  return { ...f, headers: await bearer(f.userId, f.agencyId) };
}

describe('preferred agency routes', () => {
  it('[S1-07] admins find a verified agency, add it with a note, list, edit and remove it', async () => {
    const t = newId().slice(-8);
    const owner = await verified(`Owner ${t} S.L.`);
    const partner = await verified(`Partner ${t} S.L.`);
    const { headers } = owner;

    const found = await app.inject({ method: 'GET', url: `/v1/agency-directory?q=partner%20${t}`, headers });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({
      items: [{ agencyId: partner.agencyId, name: `Partner ${t} S.L.`, kind: 'AGENCY', preferred: false }],
    });

    const url = '/v1/agency/preferred-agencies';
    const added = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { agencyId: partner.agencyId, note: ' Trusted ' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ agencyId: partner.agencyId, note: 'Trusted', listed: true });
    const again = await app.inject({ method: 'POST', url, headers, payload: { agencyId: partner.agencyId } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('PREFERRED_AGENCY_EXISTS');

    const list = await app.inject({ method: 'GET', url: `${url}?limit=10`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `${url}/${partner.agencyId}`,
      headers,
      payload: { note: 'Only for new builds' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().note).toBe('Only for new builds');

    const removed = await app.inject({ method: 'DELETE', url: `${url}/${partner.agencyId}`, headers });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: 'DELETE', url: `${url}/${partner.agencyId}`, headers });
    expect(gone.statusCode).toBe(404);
  });

  it('[S1-07] unverified agencies cannot add or search; bad input is refused before the service', async () => {
    const pending = await createFounder({ companyName: `Pending ${newId().slice(-8)} S.L.` });
    const partner = await verified(`Partner ${newId().slice(-8)} S.L.`);
    const headers = await bearer(pending.userId, pending.agencyId);
    const add = await app.inject({
      method: 'POST',
      url: '/v1/agency/preferred-agencies',
      headers,
      payload: { agencyId: partner.agencyId },
    });
    expect(add.statusCode).toBe(403);
    expect(add.json().error.code).toBe('VERIFICATION_REQUIRED');
    const search = await app.inject({ method: 'GET', url: '/v1/agency-directory?q=partner', headers });
    expect(search.statusCode).toBe(403);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/agency/preferred-agencies',
      headers: partner.headers,
      payload: { agencyId: 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(422);
    const short = await app.inject({ method: 'GET', url: '/v1/agency-directory?q=ab', headers: partner.headers });
    expect(short.statusCode).toBe(422);
    const self = await app.inject({
      method: 'POST',
      url: '/v1/agency/preferred-agencies',
      headers: partner.headers,
      payload: { agencyId: partner.agencyId },
    });
    expect(self.statusCode).toBe(422);
    expect(self.json().error.code).toBe('PREFERRED_AGENCY_INVALID');
  });
});
