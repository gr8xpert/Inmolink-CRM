import { createAccessTokenVerifier, generateAccessKeyPair, parsePublicKeys } from '@inmolink/platform/jwt';
import { createLogger } from '@inmolink/platform/logger';
import { type RateLimiter, rateLimitCoverage } from '@inmolink/platform/rate-limit';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/**
 * S16-03 rate-limit coverage: every route of the dashboard API is limited by a rule, its own or the app's defaults.
 * A route may opt out (`config.rateLimit: false`) only when it is listed here with the reason.
 */
const RATE_LIMIT_EXEMPT: Readonly<Record<string, string>> = {
  'GET /healthz': 'liveness probe of the load balancer; private network only, no work',
  'HEAD /healthz': 'liveness probe (HEAD)',
  'GET /readyz': 'readiness probe; one check at a time, result reused (S0-08 flood-safe)',
  'HEAD /readyz': 'readiness probe (HEAD)',
};

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;

const pair = generateAccessKeyPair();
const app = await buildApp({
  logger: createLogger({ level: 'silent' }),
  trustProxy: false,
  docsUi: false,
  limiter: allowAll,
  checks: {},
  verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`k1:${pair.publicKey}`) }),
});
afterAll(() => app.close());

describe('api rate-limit coverage (S16-03)', () => {
  it('[S16-03] every api route has a rate-limit rule, unless explicitly exempt with a reason', () => {
    const rows = rateLimitCoverage(app);
    expect(rows.length).toBeGreaterThan(100);
    const unlimited = rows.filter((r) => r.rules === 'off').map((r) => `${r.method} ${r.url}`);
    expect(unlimited.filter((r) => !(r in RATE_LIMIT_EXEMPT))).toEqual([]);
    // No stale exemptions: each one names a route that exists and is off.
    expect(Object.keys(RATE_LIMIT_EXEMPT).filter((r) => !unlimited.includes(r))).toEqual([]);
  });

  it('[S16-03] CORS: the dashboard API answers no browser origin (no preflight, no Allow-Origin, never credentials)', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    for (const url of ['/v1/me', '/healthz', '/nope']) {
      const res = await app.inject({ method: 'GET', url, headers: { origin: 'https://evil.example' } });
      expect(res.headers['access-control-allow-origin'], url).toBeUndefined();
      expect(res.headers['access-control-allow-credentials'], url).toBeUndefined();
    }
  });

  it('[S16-03] api answers (success, 401, 404) carry the API security headers', async () => {
    for (const url of ['/healthz', '/v1/me', '/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
    }
  });
});
