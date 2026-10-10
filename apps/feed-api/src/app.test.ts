import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { feedApiEnv } from './config';

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

describe('feed-api app', () => {
  it('[S0-08] feed-api boots with health routes', async () => {
    const app = await buildApp({
      logger: createLogger({ level: 'silent' }),
      trustProxy: 1,
      docsUi: false,
      limiter: allowAll,
      checks: { db: async () => {}, search: async () => Promise.reject(new Error('down')) },
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks).toEqual({ db: 'ok', search: 'fail' });
    } finally {
      await app.close();
    }
    // First server build loads Fastify, Swagger and the Zod provider; under `verify` (~50 parallel
    // turbo tasks) that cold load alone exceeded the 5 s default once.
  }, 30_000);

  it('[S0-08] feed-api config holds only the app_public database URL', () => {
    expect(Object.keys(feedApiEnv).filter((k) => k.startsWith('DATABASE_URL_'))).toEqual(['DATABASE_URL_APP_PUBLIC']);
    expect(Object.keys(feedApiEnv)).not.toContain('REDIS_QUEUE_URL');
  });
});
