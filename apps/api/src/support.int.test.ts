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
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** Support tickets over HTTP (S13-05): tenant scoping, staff-only routes, internal notes kept out of agency answers. */

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
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('support tickets API (S13-05)', () => {
  it("[S13-05] agency users see only their agency's tickets; internal notes are never in an agency answer", async () => {
    const a = await createFounder();
    const b = await createFounder();
    const asA = await bearer(a.userId, a.agencyId);
    const asB = await bearer(b.userId, b.agencyId);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/support/tickets',
      headers: asA,
      payload: { subject: 'Cannot publish', category: 'LISTINGS', body: 'The publish button fails.' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    expect((await app.inject({ method: 'GET', url: `/v1/support/tickets/${id}`, headers: asB })).statusCode).toBe(404);
    const listB = await app.inject({ method: 'GET', url: '/v1/support/tickets', headers: asB });
    expect(listB.json<{ items: { id: string }[] }>().items.map((t) => t.id)).not.toContain(id);

    const agent = await createStaffUser('STAFF_SUPPORT');
    const asAgent = await bearer(agent.userId);
    const note = await app.inject({
      method: 'POST',
      url: `/v1/staff/support/tickets/${id}/messages`,
      headers: asAgent,
      payload: { body: 'Internal: known bug 812.', internal: true },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json<{ messages: { internal: boolean }[] }>().messages.map((m) => m.internal)).toEqual([false, true]);

    const view = await app.inject({ method: 'GET', url: `/v1/support/tickets/${id}`, headers: asA });
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain('known bug 812');
    expect(view.json<{ messages: unknown[] }>().messages).toHaveLength(1);
  });

  it('[S13-05] staff routes answer 403 to tenants and to users without a staff role', async () => {
    const f = await createFounder();
    const routes = [
      { method: 'GET' as const, url: '/v1/staff/support/tickets' },
      { method: 'GET' as const, url: `/v1/staff/support/tickets/${newId()}` },
      { method: 'POST' as const, url: `/v1/staff/support/tickets/${newId()}/messages`, payload: { body: 'x' } },
      { method: 'PATCH' as const, url: `/v1/staff/support/tickets/${newId()}`, payload: { status: 'RESOLVED' } },
    ];
    for (const headers of [await bearer(f.userId, f.agencyId), await bearer(newId())]) {
      for (const route of routes) {
        const res = await app.inject({ ...route, headers });
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    }
  });
});
