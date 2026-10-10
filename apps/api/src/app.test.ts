import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function app(docsUi = false) {
  const a = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi,
    limiter: allowAll,
    checks: { db: async () => {} },
  });
  apps.push(a);
  return a;
}

describe('api app', () => {
  it('[S0-08] api boots with health routes', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const ready = await a.inject({ method: 'GET', url: '/readyz' });
    expect(ready.json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('[S0-08] serves /docs only when enabled (development)', async () => {
    expect((await (await app(true)).inject({ method: 'GET', url: '/docs' })).statusCode).not.toBe(404);
    expect((await (await app(false)).inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });

  it('[S0-08] withCtx refuses a request without a session (NOT_AUTHENTICATED)', async () => {
    const a = await app();
    a.get('/me', (req) => a.withCtx(req, async (ctx) => ({ agencyId: ctx.tenant.agencyId })));
    const res = await a.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('NOT_AUTHENTICATED');
  });
});
