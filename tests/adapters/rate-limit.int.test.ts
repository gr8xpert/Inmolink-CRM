import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  redis = new Redis(process.env.REDIS_LIMITS_URL as string, { protocol: 2, maxRetriesPerRequest: 1 });
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

/** The ACL that production gives redis-queue's `limits` user (Ansible group_vars). */
function limitsAcl(): string {
  const vars = readFileSync(join(import.meta.dirname, '..', '..', 'infra', 'ansible', 'group_vars', 'all.yml'), 'utf8');
  const acl = vars.match(/^redis_limits_acl: "([^"]+)"$/m)?.[1];
  if (!acl) throw new Error('redis_limits_acl missing from infra/ansible/group_vars/all.yml');
  return acl;
}

describe('quotas and penalties (S7-04)', () => {
  it('[S7-04] a fixed daily window resets at UTC midnight and says when', async () => {
    const day: RateLimitRule = { name: 'test.daily', scope: 'key', limit: 2, windowSeconds: 86_400, fixedWindow: true };
    const midnight = (Math.floor(clock.nowMs() / 86_400_000) + 1) * 86_400_000;
    expect((await limiter.consume(day, 'key-d')).allowed).toBe(true);
    const second = await limiter.consume(day, 'key-d');
    expect(second).toMatchObject({ allowed: true, remaining: 0, resetAtMs: midnight });
    const denied = await limiter.consume(day, 'key-d');
    expect(denied).toMatchObject({ allowed: false, remaining: 0, resetAtMs: midnight });
    expect(denied.retryAfterSeconds).toBe(Math.ceil((midnight - clock.nowMs()) / 1_000));
    // No weighted carry-over from yesterday: the new day starts at zero.
    clock.advance(midnight - clock.nowMs());
    expect((await limiter.consume(day, 'key-d')).allowed).toBe(true);
    expect((await limiter.consume(day, 'key-d')).allowed).toBe(true);
    expect((await limiter.consume(day, 'key-d')).allowed).toBe(false);
  });

  it('[S7-04] the penalty box: tripped once, penalized until it ends, then counted afresh', async () => {
    const boxed: RateLimitRule = { name: 'test.box', scope: 'key', limit: 2, windowSeconds: 60, penaltySeconds: 600 };
    expect((await limiter.consume(boxed, 'key-p')).allowed).toBe(true);
    expect((await limiter.consume(boxed, 'key-p')).allowed).toBe(true);
    const tripped = await limiter.consume(boxed, 'key-p');
    expect(tripped).toMatchObject({ allowed: false, tripped: true, retryAfterSeconds: 600 });
    expect(tripped.penalized).toBeUndefined();
    // The window slid out, but the penalty still holds.
    clock.advance(180_000);
    const held = await limiter.consume(boxed, 'key-p');
    expect(held).toMatchObject({ allowed: false, penalized: true, retryAfterSeconds: 420 });
    expect(held.tripped).toBeUndefined();
    // Other identities are not affected.
    expect((await limiter.consume(boxed, 'key-q')).allowed).toBe(true);
    clock.advance(420_000);
    expect((await limiter.consume(boxed, 'key-p')).allowed).toBe(true);
    expect((await limiter.consume(boxed, 'key-p')).allowed).toBe(true);
    expect(await limiter.consume(boxed, 'key-p')).toMatchObject({ allowed: false, tripped: true });
  });
});

describe('consumeMany (S7-04)', () => {
  const rule = (name: string, limit: number, extra: Partial<RateLimitRule> = {}): RateLimitRule => ({
    name,
    scope: 'key',
    limit,
    windowSeconds: 60,
    ...extra,
  });

  it('[S7-04] one call: a quota counts only when every enforced rule allowed; alert-only rules never block it', async () => {
    const quota = rule('test.many.quota', 100, { windowSeconds: 86_400, fixedWindow: true });
    const tight = rule('test.many.tight', 1);
    const watch = rule('test.many.watch', 1);
    const id = `many-${Date.now()}`;
    const call = () =>
      limiter.consumeMany(
        [
          { rule: tight, identity: id },
          { rule: watch, identity: id, observe: true },
          { rule: quota, identity: id, countLast: true },
        ],
        { slot: 'agency-1' },
      );
    const first = await call();
    expect(first.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(first[2]?.remaining).toBe(99);
    // The tight rule refuses: the quota is not counted. The watch rule is over too, but only watches.
    const second = await call();
    expect(second.map((r) => r.allowed)).toEqual([false, false, true]);
    expect(second[2]?.remaining).toBe(99);
    const third = await limiter.consumeMany([{ rule: quota, identity: id, countLast: true }], { slot: 'agency-1' });
    expect(third[0]?.remaining).toBe(98);
  });

  it('[S7-04] keys of one call share a hash slot; fixed-window keys expire at their reset', async () => {
    const slot = `slot-${Date.now()}`;
    const day = rule('test.many.day', 10, { windowSeconds: 86_400, fixedWindow: true });
    const minute = rule('test.many.minute', 10);
    await limiter.consumeMany(
      [
        { rule: day, identity: 'a' },
        { rule: minute, identity: 'b' },
      ],
      { slot },
    );
    const keys = (await redis.keys(`${prefix}:{*}:test.many.*`)).filter((k) => /test.many.(day|minute):/.test(k));
    const tags = new Set(keys.map((k) => /\{([^}]+)\}/.exec(k)?.[1]));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(tags.size).toBe(1);
    const dayKey = keys.find((k) => k.includes('test.many.day')) as string;
    const midnight = (Math.floor(clock.nowMs() / 86_400_000) + 1) * 86_400_000;
    const ttl = await redis.pttl(dayKey);
    expect(ttl).toBeLessThanOrEqual(midnight - clock.nowMs() + 1_000);
    expect(ttl).toBeGreaterThan(midnight - clock.nowMs() - 5_000);
    // A single-rule call is tagged by its identity: its own keys share a slot.
    await limiter.consume(minute, 'solo');
    const solo = await redis.keys(`${prefix}:test.many.minute:key:{*}:*`);
    expect(solo.length).toBeGreaterThanOrEqual(1);
  });

  it('[S7-04] Redis down: consumeMany fails open (closed per rule) and logs once per call, sampled', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      protocol: 2,
      maxRetriesPerRequest: 0,
      commandTimeout: 200,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    dead.on('error', () => {});
    const lines: { rules?: string[]; failClosed?: string[]; suppressed?: number }[] = [];
    const captured = createLogger({
      level: 'warn',
      destination: { write: (line: string) => lines.push(JSON.parse(line)) },
    });
    const degraded = new RateLimiter({ redis: dead, prefix, logger: captured, hmacKey });
    const checks = [
      { rule: rule('test.down.a', 1), identity: 'x' },
      { rule: rule('test.down.b', 1, { failClosed: true }), identity: 'x' },
    ];
    const results = await degraded.consumeMany(checks);
    expect(results.map((r) => r.allowed)).toEqual([true, false]);
    for (let i = 0; i < 5; i++) await degraded.consumeMany(checks);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      rules: ['test.down.a', 'test.down.b'],
      failClosed: ['test.down.b'],
      suppressed: 0,
    });
    dead.disconnect();
  });
});

describe('rate-limit store', () => {
  it('[S1-F6] counters live on a Redis that never evicts', async () => {
    const [, policy] = (await redis.config('GET', 'maxmemory-policy')) as string[];
    expect(policy).toBe('noeviction');
  });

  it("[S1-F6] production's limits user counts requests but reaches no queue key and no admin command", async () => {
    const user = `limits-${Date.now().toString(36)}`;
    const password = `pw-${Math.random().toString(36).slice(2)}`;
    await redis.call('ACL', 'SETUSER', user, 'on', `>${password}`, ...limitsAcl().split(' '));
    const url = new URL(process.env.REDIS_LIMITS_URL as string);
    const scoped = new Redis({
      host: url.hostname,
      port: Number(url.port),
      username: user,
      password,
      protocol: 2,
      connectionName: 'inmolink-limits',
      maxRetriesPerRequest: 1,
    });
    try {
      // The default prefix `inl:rl`, as in production.
      const asLimits = new RateLimiter({ redis: scoped, logger: log, clock, hmacKey });
      const rule: RateLimitRule = { name: 'test.acl', scope: 'ip', limit: 2, windowSeconds: 60 };
      const ip = `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      expect((await asLimits.consume(rule, ip)).allowed).toBe(true);
      expect((await asLimits.consume(rule, ip)).allowed).toBe(true);
      expect((await asLimits.consume(rule, ip)).allowed).toBe(false);
      // S7-04: fixed windows and the penalty box run under the same ACL (no SET, no PTTL).
      const boxed: RateLimitRule = { ...rule, name: 'test.acl-box', limit: 1, fixedWindow: true, penaltySeconds: 60 };
      expect((await asLimits.consume(boxed, ip)).allowed).toBe(true);
      expect(await asLimits.consume(boxed, ip)).toMatchObject({ allowed: false, tripped: true });
      expect(await asLimits.consume(boxed, ip)).toMatchObject({ allowed: false, penalized: true });

      await expect(scoped.get('inl:imports:meta')).rejects.toThrow(/NOPERM/);
      await expect(scoped.set('inl:rl:x', '1')).rejects.toThrow(/NOPERM/);
      await expect(scoped.call('FLUSHALL')).rejects.toThrow(/NOPERM/);
      await expect(scoped.config('GET', 'maxmemory')).rejects.toThrow(/NOPERM/);
    } finally {
      scoped.disconnect();
      await redis.call('ACL', 'DELUSER', user);
    }
  });
});
