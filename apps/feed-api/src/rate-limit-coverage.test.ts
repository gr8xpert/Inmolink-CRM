import { createLogger } from '@inmolink/platform/logger';
import { type RateLimiter, rateLimitCoverage } from '@inmolink/platform/rate-limit';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { KEYED_ROUTE_CONFIG } from './plugins/api-key';

/**
 * S16-03 rate-limit coverage: every feed-api route is limited — by its own rules or the app's per-IP default, or, on
 * the keyed website routes (`KEYED_ROUTE_LIMITS`), by `requireApiKey` itself: the key's rate tier, the agency
 * ceiling and the daily quota (S1-05, S7-04), with failed key checks limited per IP (S8-F6). Any other opt-out must
 * be listed here with its reason.
 */
const RATE_LIMIT_EXEMPT: Readonly<Record<string, string>> = {
  'GET /healthz': 'liveness probe of the load balancer; no work',
  'HEAD /healthz': 'liveness probe (HEAD)',
  'GET /readyz': 'readiness probe; one check at a time, result reused (S0-08 flood-safe)',
  'HEAD /readyz': 'readiness probe (HEAD)',
};

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

const app = await buildApp({
  logger: createLogger({ level: 'silent' }),
  trustProxy: 1,
  docsUi: false,
  limiter: allowAll,
  checks: {},
});
afterAll(() => app.close());

/** A concrete URL for a route pattern (`:id` → a value, `*` → a path). */
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, 'x1').replace(/\*/g, 'x1');

describe('feed-api rate-limit coverage (S16-03)', () => {
  it('[S16-03] every feed-api route has a rule; an opt-out is either exempt or tagged apiKeyLimited (requireApiKey runs)', () => {
    const rows = rateLimitCoverage(app);
    expect(rows.length).toBeGreaterThan(20);
    const tagged = new Set(
      app.routeTable
        .filter((r) => (r.config as { apiKeyLimited?: boolean } | undefined)?.apiKeyLimited === true)
        .map((r) => `${r.method} ${r.url}`),
    );
    const off = rows.filter((r) => r.rules === 'off').map((r) => `${r.method} ${r.url}`);
    // Every opt-out is an exemption with a reason or a keyed route; nothing else may go unlimited.
    expect(off.filter((r) => !(r in RATE_LIMIT_EXEMPT) && !tagged.has(r))).toEqual([]);
    expect(tagged.size).toBeGreaterThan(10);
    // The tag is only ever on routes that opted out of the plugin rules.
    expect([...tagged].filter((r) => !off.includes(r))).toEqual([]);
    // No stale exemptions.
    expect(Object.keys(RATE_LIMIT_EXEMPT).filter((r) => !off.includes(r))).toEqual([]);
  });

  it('[S17-F1] the rate-limit coverage reads the explicit apiKeyLimited route config (KEYED_ROUTE_CONFIG)', async () => {
    const keyed = app.routeTable.filter(
      (r) => (r.config as { apiKeyLimited?: boolean } | undefined)?.apiKeyLimited === true,
    );
    expect(keyed.length).toBeGreaterThan(10);
    for (const r of keyed) expect(r.config, `${r.method} ${r.url}`).toMatchObject(KEYED_ROUTE_CONFIG);
    // The tag is declared, never inferred: a tagged route without a requireApiKey hook refuses to start.
    const probe = await buildApp({
      logger: createLogger({ level: 'silent' }),
      trustProxy: 1,
      docsUi: false,
      limiter: allowAll,
      checks: {},
    });
    try {
      await expect(
        (async () => {
          probe.get('/v2/untagged-probe', { config: KEYED_ROUTE_CONFIG }, async () => ({}));
          await probe.ready();
        })(),
      ).rejects.toThrow(/apiKeyLimited without a requireApiKey hook/);
    } finally {
      await probe.close().catch(() => undefined);
    }
  });

  it('[S16-03] keyed routes refuse a keyless call before any work (401; failed checks are limited per IP)', async () => {
    const keyed = app.routeTable.filter(
      (r) => (r.config as { apiKeyLimited?: boolean } | undefined)?.apiKeyLimited === true,
    );
    for (const route of keyed) {
      const res = await app.inject({ method: route.method as 'GET', url: concrete(route.url) });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('[S16-03] CORS: preflights only on /v2 and never with credentials; keyless answers allow no origin', async () => {
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v2/listings',
      headers: { origin: 'https://site.example', 'access-control-request-method': 'GET' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    expect(String(pre.headers['access-control-allow-headers'])).not.toMatch(/authorization|cookie/i);
    for (const url of ['/nope', '/healthz']) {
      const res = await app.inject({
        method: 'OPTIONS',
        url,
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
      });
      expect(res.headers['access-control-allow-origin'], url).toBeUndefined();
    }
    const keyless = await app.inject({
      method: 'GET',
      url: '/v2/listings',
      headers: { origin: 'https://evil.example' },
    });
    expect(keyless.statusCode).toBe(401);
    expect(keyless.headers['access-control-allow-origin']).toBeUndefined();
    expect(keyless.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('[S16-03] feed-api answers (401, 404, health) carry the API security headers', async () => {
    for (const url of ['/healthz', '/v2/listings', '/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['strict-transport-security'], url).toMatch(/^max-age=/);
    }
  });
});

describe('feed-api limits apply to routes registered before the plugin (S16-03)', () => {
  it('[S16-03] the /v2 preflight route (registered before the rate-limit plugin) is still limited per IP', async () => {
    const denyAll = {
      ...allowAll,
      consume: async () => ({ allowed: false, limit: 1, remaining: 0, retryAfterSeconds: 7 }),
    } as unknown as RateLimiter;
    const limited = await buildApp({
      logger: createLogger({ level: 'silent' }),
      trustProxy: 1,
      docsUi: false,
      limiter: denyAll,
      checks: {},
    });
    try {
      const res = await limited.inject({
        method: 'OPTIONS',
        url: '/v2/listings',
        headers: { origin: 'https://a.example' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('7');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await limited.close();
    }
  });
});
