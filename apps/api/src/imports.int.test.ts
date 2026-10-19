import { closeDb, pingDb } from '@inmolink/core';
import * as imports from '@inmolink/core/modules/imports';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
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

/** Feed import routes over HTTP (S6-01). */

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
let unregister: () => void;

beforeAll(async () => {
  await setupTestDb('http');
  imports.configureImports({ keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }) });
  // The real connectors arrive with S6-03; the framework only needs one registered key.
  unregister = imports.registerConnector({
    key: 'api-test',
    fetch: async () => ({ body: (async function* () {})(), bytesRead: () => 0, contentType: null }),
    parse: async function* () {},
    map: () => ({ ok: false, problems: [{ code: 'UNUSED' }] }),
    validate: () => [],
  });
  app = await build();
}, 120_000);

afterAll(async () => {
  unregister();
  await app?.close();
  await closeDb();
});

describe('feed import routes', () => {
  it('[S6-01] admins connect a feed (credentials write-only), run it once at a time and read its history', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/imports/connections',
      headers,
      payload: {
        name: 'Main feed',
        connector: 'api-test',
        url: 'https://feeds.example.com/kyero.xml',
        credentials: { type: 'basic', username: 'u', password: 'top-secret-pass' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('top-secret-pass');
    const connection = created.json() as { id: string; hasCredentials: boolean; scheduleMinutes: number };
    expect(connection).toMatchObject({ hasCredentials: true, scheduleMinutes: 1440 });

    const runs = `/v1/imports/connections/${connection.id}/runs`;
    const first = await app.inject({ method: 'POST', url: runs, headers });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ state: 'QUEUED', trigger: 'MANUAL' });
    const second = await app.inject({ method: 'POST', url: runs, headers });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'FEED_RUN_ACTIVE' } });

    const history = await app.inject({ method: 'GET', url: runs, headers });
    expect(history.statusCode).toBe(200);
    expect((history.json() as { items: unknown[] }).items).toHaveLength(1);

    const stranger = await createFounder();
    const theirs = await app.inject({
      method: 'GET',
      url: `/v1/imports/connections/${connection.id}`,
      headers: await bearer(stranger.userId, stranger.agencyId),
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('[S6-01] a feed URL naming a private, loopback or metadata address is refused', async () => {
    const owner = await createFounder();
    const headers = await bearer(owner.userId, owner.agencyId);
    for (const url of ['http://169.254.169.254/latest/', 'http://127.0.0.1:8080/feed', 'http://[fd00:ec2::254]/']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports/connections',
        headers,
        payload: { name: 'Bad feed', connector: 'api-test', url },
      });
      expect(res.statusCode, url).toBe(422);
      expect(res.json(), url).toMatchObject({ error: { code: 'FEED_URL_NOT_ALLOWED' } });
    }
  });
});
