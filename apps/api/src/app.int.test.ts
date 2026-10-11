import { type Ctx, closeDb, configureDb, pingDb } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
import { AppError } from '@inmolink/platform/errors';
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

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (f: { userId: string; agencyId: string }) => ({
  authorization: `Bearer ${(await signer.sign({ sub: f.userId, aud: 'api', sv: 1, agency: f.agencyId })).token}`,
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

/** A service that loses an optimistic-concurrency race (PATTERNS §7). */
async function updateListing(ctx: Ctx, input: { version: number }): Promise<never> {
  await ctx.tx.execute('select 1');
  throw new AppError('VERSION_CONFLICT', { sentVersion: input.version });
}

let appUserUrl = '';

beforeAll(async () => {
  await setupTestDb('http');
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789' });
  appUserUrl = process.env.DATABASE_URL_APP_USER ?? '';
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('api against the test stack', () => {
  it('[S0-08] /readyz fails when Postgres is stopped', async () => {
    const app = await build();
    try {
      const up = await app.inject({ method: 'GET', url: '/readyz' });
      expect(up.statusCode).toBe(200);

      // Same pools, pointed at a Postgres that is not running.
      await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_USER: 'postgres://app_user:x@127.0.0.1:1/inmolink' });
      const down = await app.inject({ method: 'GET', url: '/readyz' });
      expect(down.statusCode).toBe(503);
      expect(down.json()).toEqual({ status: 'fail', checks: { db: 'fail' } });
    } finally {
      await app.close();
      await configureDb({
        APP_ROLE: 'http',
        DATABASE_URL_APP_USER: appUserUrl,
        DATABASE_URL_APP_AUTH: process.env.DATABASE_URL_APP_AUTH,
      });
    }
  }, 30_000);

  it('[S0-08] AppError(VERSION_CONFLICT) from a service inside withCtx returns 409 with the standard body', async () => {
    const app = await build();
    try {
      const founder = await createFounder();
      const headers = await bearer(founder);
      app.patch('/listings/:id', { onRequest: [app.requireSession] }, (req) =>
        app.withCtx(req, (ctx) => updateListing(ctx, { version: 2 })),
      );
      const res = await app.inject({ method: 'PATCH', url: `/listings/${newId()}`, headers });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: { code: 'VERSION_CONFLICT', message: 'Conflict', details: { sentVersion: 2 } },
      });
    } finally {
      await app.close();
    }
  }, 30_000);

  it('[S1-01] a founder reaches their PENDING agency through the access token', async () => {
    const app = await build();
    try {
      const founder = await createFounder({ companyName: 'Sierra Nevada Realty' });
      const headers = await bearer(founder);
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers });
      expect(me.json()).toMatchObject({ userId: founder.userId, agencyId: founder.agencyId });
      const res = await app.inject({ method: 'GET', url: '/v1/agency', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: founder.agencyId,
        kind: 'AGENCY',
        status: 'PENDING',
        name: 'Sierra Nevada Realty',
        onboarded: false,
      });
    } finally {
      await app.close();
    }
  }, 30_000);

  it('[S1-01] CIF/NIF format validated (Spanish rules) with a clear error — through the onboarding route', async () => {
    const app = await build();
    try {
      const founder = await createFounder();
      const headers = await bearer(founder);
      const body = {
        version: 1,
        name: 'Costa Homes S.L.',
        taxId: 'B12345675',
        addressLine: 'Calle Mayor 1',
        city: 'Marbella',
        postalCode: '29601',
        region: 'ES-AN',
        languages: ['es', 'en'],
      };
      const bad = await app.inject({ method: 'PUT', url: '/v1/agency/details', headers, payload: body });
      expect(bad.statusCode).toBe(422);
      expect(JSON.stringify(bad.json())).toContain('control digit or letter does not match');

      const ok = await app.inject({
        method: 'PUT',
        url: '/v1/agency/details',
        headers,
        payload: { ...body, taxId: 'b-12345674' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ taxId: 'B12345674', onboarded: true, status: 'PENDING', version: 2 });
    } finally {
      await app.close();
    }
  }, 30_000);

  it('[S1-01] a token for an agency the user does not belong to is refused', async () => {
    const app = await build();
    try {
      const a = await createFounder();
      const b = await createFounder();
      const headers = await bearer({ userId: a.userId, agencyId: b.agencyId });
      const res = await app.inject({ method: 'GET', url: '/v1/agency', headers });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('[S1-02] team routes: an admin invites (201), lists and revokes invites (204); pages carry a cursor', async () => {
    const app = await build();
    try {
      const founder = await createFounder();
      const headers = await bearer(founder);
      const email = `invitee-${newId().slice(-8)}@example.com`;
      const created = await app.inject({
        method: 'POST',
        url: '/v1/invites',
        headers,
        payload: { email: ` ${email.toUpperCase()} `, role: 'AGENT' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ email, role: 'AGENT' });
      const second = await app.inject({
        method: 'POST',
        url: '/v1/invites',
        headers,
        payload: { email: `other-${email}`, role: 'AGENCY_ADMIN' },
      });
      expect(second.statusCode).toBe(201);

      const page1 = await app.inject({ method: 'GET', url: '/v1/invites?limit=1', headers });
      expect(page1.statusCode).toBe(200);
      const { items, nextCursor } = page1.json() as { items: { id: string }[]; nextCursor: string };
      expect(items.map((i) => i.id)).toEqual([created.json().id]);
      const page2 = await app.inject({ method: 'GET', url: `/v1/invites?limit=1&cursor=${nextCursor}`, headers });
      expect(page2.json()).toMatchObject({ items: [{ id: second.json().id }], nextCursor: null });
      const badCursor = await app.inject({ method: 'GET', url: '/v1/invites?cursor=bm9wZQ', headers });
      expect(badCursor.statusCode).toBe(422);

      const revoked = await app.inject({ method: 'DELETE', url: `/v1/invites/${created.json().id}`, headers });
      expect(revoked.statusCode).toBe(204);
      const again = await app.inject({ method: 'DELETE', url: `/v1/invites/${created.json().id}`, headers });
      expect(again.statusCode).toBe(404);

      const members = await app.inject({ method: 'GET', url: '/v1/members', headers });
      expect(members.json()).toMatchObject({
        items: [{ userId: founder.userId, role: 'AGENCY_ADMIN', status: 'ACTIVE' }],
        nextCursor: null,
      });
      const ownRole = await app.inject({
        method: 'PUT',
        url: `/v1/members/${founder.userId}/role`,
        headers,
        payload: { role: 'AGENT' },
      });
      expect(ownRole.statusCode).toBe(403);
      const tooMany = await app.inject({ method: 'GET', url: '/v1/members?limit=101', headers });
      expect(tooMany.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  }, 30_000);
});
