import { loadStackEnv } from '@inmolink/db/testing';
import { createFakeClock } from '@inmolink/platform/clock';
import { createLogger } from '@inmolink/platform/logger';
import { ipBucket, RateLimiter, type RateLimitRule, rateLimitPlugin } from '@inmolink/platform/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hmacKey = 'test-rate-limit-hmac-key-0123456789abcdef';
const log = createLogger({ service: 'rate-limit-test', level: 'silent' });
const prefix = `t:rl:${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
// Mid-window start, so a test never straddles a window boundary by accident.
const clock = createFakeClock(Date.UTC(2026, 9, 10, 12, 0, 30));
let redis: Redis;
let limiter: RateLimiter;
let app: FastifyInstance;

const ipRule: RateLimitRule = { name: 'test.ip', scope: 'ip', limit: 3, windowSeconds: 60 };
const userRule: RateLimitRule = { name: 'test.user', scope: 'user', limit: 2, windowSeconds: 60 };

beforeAll(async () => {
  loadStackEnv('test');
  redis = new Redis(process.env.REDIS_CACHE_URL as string, { protocol: 2, maxRetriesPerRequest: 1 });
  await redis.ping();
  limiter = new RateLimiter({ redis, prefix, logger: log, clock, hmacKey });

  app = Fastify({ logger: false });
  app.register(rateLimitPlugin, {
    limiter,
    defaults: [ipRule, userRule],
    identify: { ip: (r) => ipBucket(r.ip), user: (r) => r.headers['x-test-user'] as string | undefined },
  });
  app.get('/limited', async () => ({ ok: true }));
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));
  const userOnly: RateLimitRule[] = [{ name: 'test.user-only', scope: 'user', limit: 2, windowSeconds: 60 }];
  app.get('/user-only', { config: { rateLimit: userOnly } }, async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

const hit = (ip: string, user?: string, url = '/limited') =>
  app.inject({ method: 'GET', url, remoteAddress: ip, headers: user ? { 'x-test-user': user } : {} });

describe('rate limits', () => {
  it('[S0-07] rate limit returns 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i++) expect((await hit('10.0.0.1')).statusCode).toBe(200);
    const res = await hit('10.0.0.1');
    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(120);
    expect(res.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { scope: 'ip', retryAfterSeconds: retryAfter } },
    });

    // After Retry-After the request is allowed again.
    clock.advance(retryAfter * 1_000);
    expect((await hit('10.0.0.1')).statusCode).toBe(200);
  });

  it('[S0-07] limits are per scope', async () => {
    // Exhausting one IP leaves another IP alone.
    for (let i = 0; i < 3; i++) await hit('10.0.0.2');
    expect((await hit('10.0.0.2')).statusCode).toBe(429);
    expect((await hit('10.0.0.3')).statusCode).toBe(200);

    // User limit: per user, independent of IP.
    expect((await hit('10.0.1.1', 'user-a')).statusCode).toBe(200);
    expect((await hit('10.0.1.2', 'user-a')).statusCode).toBe(200);
    const denied = await hit('10.0.1.3', 'user-a');
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.details.scope).toBe('user');
    expect((await hit('10.0.1.4', 'user-b')).statusCode).toBe(200);
  });

  it('[S0-07] the same identity under different scopes uses separate counters', async () => {
    const id = 'shared-id';
    const tenant: RateLimitRule = { name: 'test.scoped', scope: 'tenant', limit: 1, windowSeconds: 60 };
    const key: RateLimitRule = { name: 'test.scoped', scope: 'key', limit: 1, windowSeconds: 60 };
    expect((await limiter.consume(tenant, id)).allowed).toBe(true);
    expect((await limiter.consume(tenant, id)).allowed).toBe(false);
    expect((await limiter.consume(key, id)).allowed).toBe(true);
  });

  it('[S0-07] the window slides: the previous window still counts, weighted', async () => {
    const rule: RateLimitRule = { name: 'test.slide', scope: 'ip', limit: 10, windowSeconds: 60 };
    const start = Date.UTC(2026, 9, 10, 13, 0, 59); // 1 s before a window boundary
    clock.set(start);
    for (let i = 0; i < 10; i++) expect((await limiter.consume(rule, 'slide')).allowed).toBe(true);
    clock.set(start + 2_000); // 1 s into the next window: ~98 % of the previous 10 still count
    expect((await limiter.consume(rule, 'slide')).allowed).toBe(false);
    clock.set(start + 31_000); // halfway: 5 of 10 count
    for (let i = 0; i < 5; i++) expect((await limiter.consume(rule, 'slide')).allowed).toBe(true);
    expect((await limiter.consume(rule, 'slide')).allowed).toBe(false);
  });

  it('[S0-07] a scope without identity counts against the client IP instead of being skipped', async () => {
    expect((await hit('10.0.2.1', undefined, '/user-only')).statusCode).toBe(200);
    expect((await hit('10.0.2.1', undefined, '/user-only')).statusCode).toBe(200);
    expect((await hit('10.0.2.1', undefined, '/user-only')).statusCode).toBe(429);
    expect((await hit('10.0.2.1', 'user-c', '/user-only')).statusCode).toBe(200);
  });

  it('[S0-07] IPv6 addresses share a /64 bucket', async () => {
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'));
    expect(ipBucket('::ffff:10.0.0.1')).toBe('10.0.0.1');
    for (let i = 0; i < 3; i++) await hit(`2001:db8:9:9::${i + 1}`);
    expect((await hit('2001:db8:9:9::ffff')).statusCode).toBe(429);
  });

  it('[S0-07] invalid rules fail at registration, not on first request', async () => {
    const bad = Fastify({ logger: false });
    bad.register(rateLimitPlugin, { limiter, defaults: [ipRule], identify: { ip: (r) => r.ip } });
    const keyRule: RateLimitRule[] = [{ name: 'test.key', scope: 'key', limit: 1, windowSeconds: 60 }];
    bad.register(async (f) => {
      f.get('/x', { config: { rateLimit: keyRule } }, async () => 1);
    });
    await expect(bad.ready()).rejects.toThrow(/identify.key/);
    const login = Fastify({ logger: false });
    login.register(rateLimitPlugin, {
      limiter,
      defaults: [{ name: 'auth.login', scope: 'ip', limit: 5, windowSeconds: 60 }],
      identify: { ip: (r) => r.ip },
    });
    await expect(login.ready()).rejects.toThrow(/failClosed/);
  });

  it('[S0-07] routes can opt out (health checks)', async () => {
    for (let i = 0; i < 5; i++) expect((await hit('10.0.0.9', undefined, '/health')).statusCode).toBe(200);
  });

  it('[S0-07] Redis down: fails open by default, closed when the rule says so', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      protocol: 2,
      maxRetriesPerRequest: 0,
      commandTimeout: 200,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    dead.on('error', () => {}); // expected: nothing listens on port 1
    const degraded = new RateLimiter({ redis: dead, prefix, logger: log, hmacKey });
    expect((await degraded.consume(ipRule, '10.9.9.9')).allowed).toBe(true);
    const closed = await degraded.consume({ ...ipRule, failClosed: true }, '10.9.9.9');
    expect(closed.allowed).toBe(false);
    expect(closed.retryAfterSeconds).toBeGreaterThan(0);
    dead.disconnect();
  });
});
