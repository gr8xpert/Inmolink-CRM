import type { ApiKeyScope, CreateApiKeyInput } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import { createFounder } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter, RateLimitRule } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

/** `requireApiKey` over HTTP (S1-05): a stand-in website route, as feed-api's v2 routes will use it (S7). */

/** Allows everything except the rule names in `deny`. */
function limiter(deny: Set<string>, seen: RateLimitRule[] = []): RateLimiter {
  const consume = async (rule: RateLimitRule) => {
    seen.push(rule);
    return deny.has(rule.name)
      ? { allowed: false, limit: rule.limit, remaining: 0, retryAfterSeconds: 7, resetAtMs: 0 }
      : { allowed: true, limit: rule.limit, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 };
  };
  return {
    consume,
    credit: async () => undefined,
    // S7-F9: a peek (the failed-checks penalty, before a key lookup) reads the rule without counting it.
    consumeMany: (checks: readonly { rule: RateLimitRule; peek?: boolean }[]) =>
      Promise.all(
        checks.map((c) =>
          c.peek
            ? Promise.resolve(
                deny.has(c.rule.name)
                  ? { allowed: false, limit: c.rule.limit, remaining: 0, retryAfterSeconds: 7, resetAtMs: 0 }
                  : { allowed: true, limit: c.rule.limit, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 },
              )
            : consume(c.rule),
        ),
      ),
  } as unknown as RateLimiter;
}

const deny = new Set<string>();
const consumed: RateLimitRule[] = [];

async function build() {
  const app = await buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: limiter(deny, consumed),
    checks: {},
  });
  app.get('/v2/test-listings', { onRequest: [app.requireApiKey('listings:read')] }, async (req) => ({
    agencyId: req.apiKey?.agencyId,
  }));
  app.post('/v2/test-leads', { onRequest: [app.requireApiKey('leads:write')] }, async () => ({ ok: true }));
  return app;
}

let app: Awaited<ReturnType<typeof build>>;
let agencyId: string;
let secretKey: string;
let publishableKey: string;

async function issue(founder: { userId: string; agencyId: string }, input: CreateApiKeyInput): Promise<string> {
  const issued = await withMemberCtx(
    { userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' },
    (ctx) => identity.createApiKey(ctx, input),
  );
  return issued.secret;
}

beforeAll(async () => {
  await setupTestDb('http');
  await configureCache({ prefix: `t:feedkeys:${newId().slice(-12)}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  const founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  agencyId = founder.agencyId;
  const scopes: ApiKeyScope[] = ['listings:read'];
  secretKey = await issue(founder, { name: 'WP', kind: 'SECRET', scopes, allowedOrigins: [] });
  publishableKey = await issue(founder, {
    name: 'Widget',
    kind: 'PUBLISHABLE',
    scopes,
    allowedOrigins: ['https://www.costa-homes.example'],
  });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeCache();
  await closeDb();
});

const get = (headers: Record<string, string>, remoteAddress?: string) =>
  app.inject({ method: 'GET', url: '/v2/test-listings', headers, ...(remoteAddress ? { remoteAddress } : {}) });
/** A well-formed key nobody issued (its prefix costs a database lookup unless refused first). */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const guessed = (i: number) =>
  `inl_test_sk${Array.from({ length: 10 }, (_, k) => B32[Math.floor(i / 32 ** k) % 32]).join('')}_${'a'.repeat(52)}`;

describe('requireApiKey', () => {
  it('[S1-05] publishable key from a non-allowlisted origin is rejected', async () => {
    const ok = await get({ 'x-api-key': publishableKey, origin: 'https://www.costa-homes.example' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ agencyId });

    const evil = await get({ 'x-api-key': publishableKey, origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('API_KEY_ORIGIN_DENIED');
    const none = await get({ 'x-api-key': publishableKey });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe('API_KEY_ORIGIN_DENIED');
  });

  it('[S1-05] secret keys authenticate by X-Api-Key or Bearer; anything else is 401', async () => {
    expect((await get({ 'x-api-key': secretKey })).statusCode).toBe(200);
    expect((await get({ authorization: `Bearer ${secretKey}` })).statusCode).toBe(200);
    for (const headers of <Record<string, string>[]>[
      {},
      { 'x-api-key': 'inl_test_nope' },
      { authorization: `Basic ${secretKey}` },
    ]) {
      const res = await get(headers);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('API_KEY_INVALID');
    }
  });

  it('[S1-05] the route scope is enforced', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/test-leads', headers: { 'x-api-key': secretKey } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_SCOPE_DENIED');
  });

  it('[S1-05] a secret key sent with an Origin header (from a browser) is refused', async () => {
    const res = await get({ 'x-api-key': secretKey, origin: 'https://www.costa-homes.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_ORIGIN_DENIED');
  });

  it('[S1-05] each key is rate limited by its tier, and the agency over all its keys', async () => {
    consumed.length = 0;
    await get({ 'x-api-key': secretKey });
    expect(consumed.find((r) => r.scope === 'key')).toMatchObject({
      name: 'feed.key.standard',
      limit: identity.API_KEYS.RATE_TIERS.STANDARD.limit,
    });
    expect(consumed.find((r) => r.scope === 'tenant')).toMatchObject({
      name: 'feed.agency',
      limit: identity.API_KEYS.AGENCY_RATE.limit,
    });
    expect(identity.apiKeyRateRule('HIGH')).toMatchObject({ name: 'feed.key.high', limit: 3_000 });

    for (const [rule, scope] of [
      ['feed.key.standard', 'key'],
      ['feed.agency', 'tenant'],
    ] as const) {
      deny.add(rule);
      try {
        const res = await get({ 'x-api-key': secretKey });
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBe('7');
        expect(res.json().error).toMatchObject({ code: 'RATE_LIMITED', details: { scope } });
      } finally {
        deny.clear();
      }
    }
  });

  it('[S1-05] failed key checks are rate limited per client IP; good keys do not count', async () => {
    consumed.length = 0;
    await get({ 'x-api-key': secretKey });
    expect(consumed.some((r) => r.name === 'feed.keyfail.ip')).toBe(false);
    await get({ 'x-api-key': 'inl_test_skaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(consumed.filter((r) => r.name === 'feed.keyfail.ip')).toHaveLength(1);
    deny.add('feed.keyfail.ip');
    try {
      const res = await get({ 'x-api-key': 'inl_test_nope' });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.details.scope).toBe('ip');
    } finally {
      deny.clear();
    }
  });

  it('[S7-F9] publishable traffic counts in its own key and agency pools, alert only: never the secret key pools', async () => {
    consumed.length = 0;
    deny.add('feed.key.pk.standard');
    deny.add('feed.agency.pk');
    try {
      // Over both publishable pools: still answered (alert only), and they are not the pools secret keys run under.
      const res = await get({ 'x-api-key': publishableKey, origin: 'https://www.costa-homes.example' });
      expect(res.statusCode).toBe(200);
      expect(consumed.map((r) => r.name)).toEqual(expect.arrayContaining(['feed.key.pk.standard', 'feed.agency.pk']));
      expect(consumed.map((r) => r.name)).not.toContain('feed.key.standard');
      expect(consumed.map((r) => r.name)).not.toContain('feed.agency');
    } finally {
      deny.clear();
    }
    // Per IP over every publishable key (`feed.pk.ip`), enforced.
    deny.add('feed.pk.ip');
    try {
      const res = await get({ 'x-api-key': publishableKey, origin: 'https://www.costa-homes.example' });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.details.scope).toBe('ip');
      expect((await get({ 'x-api-key': secretKey })).statusCode).toBe(200);
    } finally {
      deny.clear();
    }
  });

  it('[S7-F9] a wrong origin or scope counts as a failed check; the penalty refuses only uncached lookups', async () => {
    consumed.length = 0;
    await get({ 'x-api-key': publishableKey, origin: 'https://evil.example' });
    await app.inject({ method: 'POST', url: '/v2/test-leads', headers: { 'x-api-key': secretKey } });
    expect(consumed.filter((r) => r.name === 'feed.keyfail.ip')).toHaveLength(2);
    deny.add('feed.keyfail.ip');
    try {
      // A key the cache knows keeps working for everyone on the address (shared IPs); an unknown one is refused
      // before its database lookup.
      expect((await get({ 'x-api-key': secretKey })).statusCode).toBe(200);
      const refused = await get({ 'x-api-key': guessed(4_242) });
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.details.scope).toBe('ip');
    } finally {
      deny.clear();
    }
  });

  it('[S7-F9] with Redis not answering (the limiter allows), the in-process count still stops guessed-key lookups', async () => {
    const ip = '198.51.100.77';
    const statuses: number[] = [];
    for (let i = 0; i < identity.API_KEY_FAILURE_RULE.limit + 3; i++) {
      statuses.push((await get({ 'x-api-key': guessed(10_000 + i) }, ip)).statusCode);
    }
    expect(statuses.slice(0, identity.API_KEY_FAILURE_RULE.limit).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(identity.API_KEY_FAILURE_RULE.limit).every((s) => s === 429)).toBe(true);
    // Another address is not affected.
    expect((await get({ 'x-api-key': guessed(20_000) }, '198.51.100.78')).statusCode).toBe(401);
  });
});
