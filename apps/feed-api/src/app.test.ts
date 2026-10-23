import * as identity from '@inmolink/core/modules/identity';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { coreEnv, httpEnv, loadConfig } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter, RateLimitRule } from '@inmolink/platform/rate-limit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { assertFeedApiTrustProxy, feedApiEnv } from './config';
import { createLocalFailedChecks, FAILED_CHECKS_TRACKED } from './plugins/api-key';

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
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

  it('[S0-08] feed-api config holds only the app_public database URL and (S7-05) the narrow intake role', () => {
    expect(Object.keys(feedApiEnv).filter((k) => k.startsWith('DATABASE_URL_'))).toEqual([
      'DATABASE_URL_APP_PUBLIC',
      'DATABASE_URL_APP_INTAKE',
    ]);
    expect(Object.keys(feedApiEnv)).not.toContain('REDIS_QUEUE_URL');
  });

  it('[S7-F9] TRUST_PROXY: production requires a proxy IP / CIDR allowlist (no false, no hop count); dev keeps defaults', () => {
    const parse = (env: Record<string, string>) =>
      loadConfig({ NODE_ENV: coreEnv.NODE_ENV, TRUST_PROXY: httpEnv.TRUST_PROXY }, env);
    const prod = (TRUST_PROXY: string) => assertFeedApiTrustProxy(parse({ NODE_ENV: 'production', TRUST_PROXY }));
    expect(() => prod('false')).toThrow(/TRUST_PROXY/);
    expect(() => prod('1')).toThrow(/TRUST_PROXY/);
    expect(() => parse({ NODE_ENV: 'production', TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => prod('10.200.0.0/24,173.245.48.0/20,2400:cb00::/32')).not.toThrow();
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => assertFeedApiTrustProxy(parse({ NODE_ENV }))).not.toThrow();
      expect(() => assertFeedApiTrustProxy(parse({ NODE_ENV, TRUST_PROXY: '1' }))).not.toThrow();
    }
  });

  it('[S7-F9] an OPTIONS /v2/* preflight is rate limited per IP (the plugin default)', async () => {
    const seen: RateLimitRule[] = [];
    let denyIp = false;
    const consume = async (rule: RateLimitRule) => {
      seen.push(rule);
      const allowed = !(denyIp && rule.scope === 'ip');
      return {
        allowed,
        limit: rule.limit,
        remaining: allowed ? 1 : 0,
        retryAfterSeconds: allowed ? 0 : 9,
        resetAtMs: 0,
      };
    };
    const limiter = {
      consume,
      credit: async () => undefined,
      consumeMany: (checks: readonly { rule: RateLimitRule }[]) => Promise.all(checks.map((c) => consume(c.rule))),
    } as unknown as RateLimiter;
    const app = await buildApp({
      logger: createLogger({ level: 'silent' }),
      trustProxy: false,
      docsUi: false,
      limiter,
      checks: {},
    });
    try {
      const preflight = () =>
        app.inject({ method: 'OPTIONS', url: '/v2/listings', headers: { origin: 'https://www.site.example' } });
      expect((await preflight()).statusCode).toBe(204);
      expect(seen.map((r) => r.name)).toContain('feed.ip');
      denyIp = true;
      const refused = await preflight();
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.details.scope).toBe('ip');
    } finally {
      await app.close();
    }
  }, 30_000);

  it('[S7-F9] the in-process failed-check count: the rule limit per IP per window, bounded memory', () => {
    const clock = useFakeClock('2026-10-23T10:00:00Z');
    try {
      const local = createLocalFailedChecks();
      const { limit, windowSeconds } = identity.API_KEY_FAILURE_RULE;
      for (let i = 0; i < limit - 1; i++) local.hit('ip', 'a', limit);
      expect(local.peek('ip', 'a', limit)).toBe(0);
      local.hit('ip', 'a', limit);
      expect(local.peek('ip', 'a', limit)).toBe(windowSeconds);
      expect(local.peek('ip', 'b', limit)).toBe(0);
      clock.advance((windowSeconds - 15) * 1_000);
      expect(local.peek('ip', 'a', limit)).toBe(15);
      clock.advance(15_000);
      expect(local.peek('ip', 'a', limit)).toBe(0);
      for (let i = 0; i < FAILED_CHECKS_TRACKED + 5; i++) local.hit('ip', `ip${i}`, limit);
      expect(local.size('ip')).toBe(FAILED_CHECKS_TRACKED);
    } finally {
      restoreClock();
    }
  });
});
