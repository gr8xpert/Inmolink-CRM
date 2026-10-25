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

/** Staff console operations over HTTP (S13-03): 403 for anyone not staff, role checks, no caching. */

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
  await configureQueue({ prefix: `test-api-staff-ops-${newId().slice(-8)}`, logger: log });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeQueues();
  await closeDb();
});

const REASON = 'Ticket 4711: read models drifted after the rename';

describe('staff console operations API (S13-03)', () => {
  it('[S13-03] every operations route answers 403 to tenants and users without a staff role', async () => {
    const f = await createFounder();
    const routes = [
      { method: 'GET' as const, url: '/v1/staff/operations' },
      { method: 'POST' as const, url: '/v1/staff/operations', payload: { kind: 'REINDEX', reason: REASON } },
      { method: 'GET' as const, url: `/v1/staff/operations/${newId()}` },
      { method: 'POST' as const, url: `/v1/staff/operations/${newId()}/cancel` },
      { method: 'GET' as const, url: `/v1/staff/agencies/${f.agencyId}/billing` },
      { method: 'GET' as const, url: '/v1/staff/feature-flags' },
      { method: 'GET' as const, url: '/v1/staff/queues/health' },
      { method: 'GET' as const, url: '/v1/staff/ai-spend' },
    ];
    for (const headers of [await bearer(f.userId, f.agencyId), await bearer(newId())]) {
      for (const route of routes) {
        const res = await app.inject({ ...route, headers });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    }
  });

  it('[S13-03] data ops start, follow and cancel an operation; support only looks; responses are not cached', async () => {
    const f = await createFounder();
    const ops = await bearer((await createStaffUser('STAFF_DATA_OPS')).userId);
    const support = await bearer((await createStaffUser('STAFF_SUPPORT')).userId);
    const payload = { kind: 'REBUILD_READ_MODELS', agencyId: f.agencyId, reason: REASON };

    const refused = await app.inject({ method: 'POST', url: '/v1/staff/operations', headers: support, payload });
    expect(refused.statusCode).toBe(403);
    const started = await app.inject({ method: 'POST', url: '/v1/staff/operations', headers: ops, payload });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const op = started.json();
    expect(op).toMatchObject({ state: 'QUEUED', kind: 'REBUILD_READ_MODELS', agencyId: f.agencyId });
    const twice = await app.inject({ method: 'POST', url: '/v1/staff/operations', headers: ops, payload });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('STAFF_OPERATION_ACTIVE');

    const got = await app.inject({ method: 'GET', url: `/v1/staff/operations/${op.id}`, headers: support });
    expect(got.json()).toMatchObject({ id: op.id, done: 0, total: null });
    const cancelled = await app.inject({ method: 'POST', url: `/v1/staff/operations/${op.id}/cancel`, headers: ops });
    expect(cancelled.json()).toMatchObject({ state: 'CANCELLED', cancelRequested: true });

    const badReplay = await app.inject({
      method: 'POST',
      url: '/v1/staff/operations',
      headers: ops,
      payload: { kind: 'REPLAY_OUTBOX', reason: REASON },
    });
    expect(badReplay.statusCode).toBe(422);

    const health = await app.inject({ method: 'GET', url: '/v1/staff/queues/health', headers: support });
    expect(health.statusCode, health.body).toBe(200);
    expect(health.json().reachable).toBe(true);
    const spend = await app.inject({ method: 'GET', url: '/v1/staff/ai-spend?month=2026-01', headers: support });
    expect(spend.statusCode, spend.body).toBe(200);
    expect(spend.json().month).toBe('2026-01');
  });
});
