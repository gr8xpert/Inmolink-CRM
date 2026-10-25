import { createHmac } from 'node:crypto';
import { closeDb, pingDb } from '@inmolink/core';
import * as billing from '@inmolink/core/modules/billing';
import { createFounder } from '@inmolink/core/test';
import { setupTestDb } from '@inmolink/db/testing';
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
import type { RateLimiter, RateLimitRule } from '@inmolink/platform/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { WEBHOOK_SIGNED_LIMIT, WEBHOOK_UNSIGNED_LIMIT } from './routes/billing/routes';

/** Billing over HTTP (S13-01): the overview, request validation, and Stripe's raw-body webhook. */

const allowAll = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
} as unknown as RateLimiter;
const pair = generateAccessKeyPair();
const signer = createAccessTokenSigner({ privateKey: privateKeyFromBase64(pair.privateKey), keyId: 't1' });
const bearer = async (sub: string, agency: string) => ({
  authorization: `Bearer ${(await signer.sign({ sub, aud: 'api', sv: 1, agency })).token}`,
});
const WEBHOOK_SECRET = 'whsec_apitest0123456789abcdef';
const log = createLogger({ level: 'silent' });
/** Counts per rule and identity like the Redis limiter (one window: the test runs well inside a minute). */
const countingLimiter = () => {
  const used = new Map<string, number>();
  const limiter = {
    consume: async (rule: RateLimitRule, identity: string) => {
      const key = `${rule.name}:${identity}`;
      const n = (used.get(key) ?? 0) + 1;
      used.set(key, n);
      const allowed = n <= rule.limit;
      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - n),
        retryAfterSeconds: allowed ? 0 : 60,
      };
    },
  } as unknown as RateLimiter;
  return { limiter, used };
};
const build = (limiter: RateLimiter = allowAll) =>
  buildApp({
    logger: log,
    trustProxy: false,
    docsUi: false,
    limiter,
    readinessCacheMs: 0,
    checks: { db: () => pingDb('app_user') },
    verifier: createAccessTokenVerifier({ publicKeys: parsePublicKeys(`t1:${pair.publicKey}`) }),
  });
let app: Awaited<ReturnType<typeof build>>;

/** Signs like Stripe: HMAC-SHA256 of `t.body` with the endpoint secret. */
const sign = (body: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')}`;

beforeAll(async () => {
  await setupTestDb('http');
  await configureQueue({ prefix: `test-api-billing-${newId().slice(-8)}`, logger: log });
  billing.configureBilling({
    stripe: {
      secretKey: 'sk_test_apitest0123456789',
      apiUrl: 'https://api.stripe.invalid',
      webhookSecret: WEBHOOK_SECRET,
      returnUrl: 'http://web.test/billing',
    },
  });
  app = await build();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeQueues();
  await closeDb();
});

describe('billing routes', () => {
  it('[S13-01] members read the plan in force (Free without a subscription)', async () => {
    const f = await createFounder();
    const res = await app.inject({ method: 'GET', url: '/v1/billing', headers: await bearer(f.userId, f.agencyId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ plan: 'free', subscription: null, hasCustomer: false, canManage: true });
    expect((await app.inject({ method: 'GET', url: '/v1/billing' })).statusCode).toBe(401);
  });

  it('[S13-01] checkout bodies are validated as JSON (the webhook keeps its raw body only in its own route)', async () => {
    const f = await createFounder();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: await bearer(f.userId, f.agencyId),
      payload: { planCode: 'Pro!', interval: 'WEEK' },
    });
    expect(res.statusCode).toBe(422);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: await bearer(f.userId, f.agencyId),
      payload: { planCode: `nope_${newId().slice(-6)}` },
    });
    expect(unknown.json()).toMatchObject({ error: { code: 'BILLING_PRICE_UNAVAILABLE' } });
  });

  it('[S13-01] Stripe webhook: verified on the raw body, acknowledged at once; a bad signature is refused', async () => {
    // Stripe's own formatting (spaces, key order) is what is signed: re-serialising would break the signature.
    const body = `{\n  "id": "evt_${newId().replace(/-/g, '')}",\n  "type": "customer.subscription.updated",\n  "data": { "object": { "id": "sub_1", "object": "subscription", "customer": "cus_1" } }\n}`;
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ received: true });

    // Stripe's own content type carries a charset: the raw-body parser still takes it.
    const charset = await app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': sign(body) },
      payload: body,
    });
    expect(charset.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(`${body} `) },
      payload: body,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'BILLING_WEBHOOK_INVALID' } });

    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(400);
  });

  it('[S13-F20] a flood of unsigned requests from one address leaves signed deliveries from it accepted', async () => {
    const { limiter, used } = countingLimiter();
    const limited = await build(limiter);
    try {
      // Stripe's egress addresses are shared: the junk and Stripe's deliveries arrive from the same IP.
      const remoteAddress = '3.18.12.63';
      const body = (n: number) =>
        `{"id":"evt_f20${n}${newId().replace(/-/g, '').slice(-12)}","type":"customer.subscription.updated","data":{"object":{"id":"sub_f20","object":"subscription","customer":"cus_f20"}}}`;
      const flood = WEBHOOK_UNSIGNED_LIMIT.limit + 40;
      const junk: number[] = [];
      for (let i = 0; i < flood; i++) {
        const res = await limited.inject({
          method: 'POST',
          url: '/v1/billing/stripe/webhook',
          remoteAddress,
          headers: { 'content-type': 'application/json', ...(i % 2 ? { 'stripe-signature': 't=1,v1=00' } : {}) },
          payload: body(i),
        });
        junk.push(res.statusCode);
      }
      expect(junk.slice(0, WEBHOOK_UNSIGNED_LIMIT.limit).every((c) => c === 400)).toBe(true);
      expect(junk.slice(WEBHOOK_UNSIGNED_LIMIT.limit).every((c) => c === 429)).toBe(true);
      expect(used.get(`${WEBHOOK_SIGNED_LIMIT.name}:${remoteAddress}`)).toBeUndefined();

      for (let i = 0; i < 5; i++) {
        const payload = body(1_000 + i);
        const ok = await limited.inject({
          method: 'POST',
          url: '/v1/billing/stripe/webhook',
          remoteAddress,
          headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
          payload,
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ received: true });
      }
      expect(used.get(`${WEBHOOK_SIGNED_LIMIT.name}:${remoteAddress}`)).toBe(5);

      // Signed deliveries have a ceiling of their own, and junk is still refused after them.
      used.set(`${WEBHOOK_SIGNED_LIMIT.name}:${remoteAddress}`, WEBHOOK_SIGNED_LIMIT.limit);
      const payload = body(2_000);
      const over = await limited.inject({
        method: 'POST',
        url: '/v1/billing/stripe/webhook',
        remoteAddress,
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
        payload,
      });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(over.headers['retry-after']).toBe('60');
    } finally {
      await limited.close();
    }
  });
});
