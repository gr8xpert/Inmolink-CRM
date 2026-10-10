import { type Ctx, closeDb, configureDb, pingDb } from '@inmolink/core';
import { setupTestDb } from '@inmolink/db/testing';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const build = () =>
  buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allowAll,
    readinessCacheMs: 0,
    checks: { db: () => pingDb('app_user') },
  });

/** A service that loses an optimistic-concurrency race (PATTERNS §7). */
async function updateListing(ctx: Ctx, input: { version: number }): Promise<never> {
  await ctx.tx.execute('select 1');
  throw new AppError('VERSION_CONFLICT', { sentVersion: input.version });
}

let appUserUrl = '';

beforeAll(async () => {
  await setupTestDb('http');
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
      await configureDb({ APP_ROLE: 'http', DATABASE_URL_APP_USER: appUserUrl });
    }
  }, 30_000);

  it('[S0-08] AppError(VERSION_CONFLICT) from a service inside withCtx returns 409 with the standard body', async () => {
    const app = await build();
    try {
      const agencyId = newId();
      app.addHook('onRequest', async (req) => {
        req.auth = {
          tenant: { agencyId, verified: true, plan: 'test', locales: ['en'] },
          actor: { kind: 'user', userId: newId(), role: 'agent' },
          locale: 'en',
          clientMode: false,
        };
      });
      app.patch('/listings/:id', (req) => app.withCtx(req, (ctx) => updateListing(ctx, { version: 2 })));
      const res = await app.inject({ method: 'PATCH', url: `/listings/${newId()}` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: { code: 'VERSION_CONFLICT', message: 'Conflict', details: { sentVersion: 2 } },
      });
    } finally {
      await app.close();
    }
  }, 30_000);
});
