import { closeDb, pingDb } from '@inmolink/core';
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

/** Data export routes over HTTP (S10-08): create (Idempotency-Key), list, get — a link only with download=1. */

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

describe('data export routes', () => {
  it('[S10-08] POST queues an export (201), a retry with the Idempotency-Key replays it (200), a second export waits (409)', async () => {
    const f = await createFounder();
    const headers = { ...(await bearer(f.userId, f.agencyId)), 'idempotency-key': `dx-${newId()}` };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers,
      payload: { kind: 'CONTACTS', format: 'xlsx' },
    });
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(created).toMatchObject({ kind: 'CONTACTS', format: 'xlsx', status: 'QUEUED', download: null });

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers,
      payload: { kind: 'CONTACTS', format: 'xlsx' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(created.id);

    const other = await app.inject({
      method: 'POST',
      url: '/v1/agency/data-exports',
      headers: await bearer(f.userId, f.agencyId),
      payload: { kind: 'LEADS' },
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
    const [a, b] = await Promise.all([createFounder(), createFounder()]);
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agency/data-exports',
        headers: await bearer(a.userId, a.agencyId),
        payload: { kind: 'LISTINGS' },
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
      payload: { kind: 'EVERYTHING' },
    });
    expect(bad.statusCode).toBe(422);
  });
});
