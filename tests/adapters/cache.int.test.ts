import { loadStackEnv } from '@inmolink/db/testing';
import { Cache, type CacheKey, cacheKey } from '@inmolink/platform/cache';
import { createLogger } from '@inmolink/platform/logger';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const log = createLogger({ service: 'cache-test', level: 'silent' });
const prefix = `t:c:${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let redis: Redis;
let cache: Cache;

beforeAll(async () => {
  loadStackEnv('test');
  redis = new Redis(process.env.REDIS_CACHE_URL as string, { protocol: 2, maxRetriesPerRequest: 1 });
  await redis.ping();
  cache = new Cache({ redis, prefix, logger: log });
});

afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

/** Test keys: module `test`, entity = the string's first part, id = the rest. */
const k = (s: string): CacheKey => {
  const [entity = 'x', ...id] = s.split(':');
  return cacheKey({ v: 1, module: 'test', entity, scope: 'global', id: id.join(':') || undefined });
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cache', () => {
  it('[S0-07] 100 concurrent misses on one key cause exactly one loader call', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      await delay(50);
      return { id: 'x', n: 42 };
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => cache.get(k('single-flight:1'), { ttlSeconds: 60 }, loader)),
    );
    expect(calls).toBe(1);
    expect(results.every((r) => r.n === 42)).toBe(true);
    // Later reads hit Redis, not the loader.
    await cache.get(k('single-flight:1'), { ttlSeconds: 60 }, loader);
    expect(calls).toBe(1);
  });

  it('[S0-07] tag invalidation removes all tagged keys', async () => {
    const loads: string[] = [];
    const load = (key: string) => async () => {
      loads.push(key);
      return key;
    };
    const tagged = [k('tags:a'), k('tags:b'), k('tags:c')];
    for (const key of tagged) await cache.get(key, { ttlSeconds: 60, tags: ['taxonomy', 'other'] }, load(key));
    await cache.get(k('tags:untagged'), { ttlSeconds: 60, tags: ['other'] }, load('untagged'));
    await cache.get(k('tags:local'), { ttlSeconds: 60, tags: ['taxonomy'], local: true }, load('local'));
    expect(loads).toHaveLength(5);

    // Warm: no loads.
    for (const key of tagged) await cache.get(key, { ttlSeconds: 60, tags: ['taxonomy', 'other'] }, load(key));
    expect(loads).toHaveLength(5);

    await cache.invalidateTag('taxonomy');
    loads.length = 0;
    for (const key of tagged) await cache.get(key, { ttlSeconds: 60, tags: ['taxonomy', 'other'] }, load(key));
    await cache.get(k('tags:untagged'), { ttlSeconds: 60, tags: ['other'] }, load('untagged'));
    await cache.get(k('tags:local'), { ttlSeconds: 60, tags: ['taxonomy'], local: true }, load('local'));
    expect(loads.sort()).toEqual([...tagged, 'local'].sort());
  });

  it('[S0-07] an evicted tag version invalidates its entries instead of serving stale data', async () => {
    let n = 0;
    const loader = async () => ++n;
    expect(await cache.get(k('evict:1'), { ttlSeconds: 60, tags: ['evict'] }, loader)).toBe(1);
    await redis.del(`${prefix}:tag:evict`); // what allkeys-lru may do
    expect(await cache.get(k('evict:1'), { ttlSeconds: 60, tags: ['evict'] }, loader)).toBe(2);
    expect(await cache.get(k('evict:1'), { ttlSeconds: 60, tags: ['evict'] }, loader)).toBe(2);
  });

  it('[S0-07] an invalidation during a load is not overwritten by the stale result', async () => {
    let n = 0;
    const slow = async () => {
      const value = ++n;
      if (value === 1) await cache.invalidateTag('race'); // the data changed while we were loading
      return value;
    };
    expect(await cache.get(k('race:1'), { ttlSeconds: 60, tags: ['race'] }, slow)).toBe(1);
    expect(await cache.get(k('race:1'), { ttlSeconds: 60, tags: ['race'] }, slow)).toBe(2);
  });

  it('[S0-07] local entries serve without Redis and expire', async () => {
    let n = 0;
    const key = k('local:1');
    await cache.get(key, { ttlSeconds: 60, local: true }, async () => ++n);
    await redis.del(`${prefix}:${key}`);
    expect(await cache.get(key, { ttlSeconds: 60, local: true }, async () => ++n)).toBe(1);
    cache.clearLocal();
    expect(await cache.get(key, { ttlSeconds: 60, local: true }, async () => ++n)).toBe(2);
  });

  it('[S0-07] Redis down: falls through to the loader', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      protocol: 2,
      maxRetriesPerRequest: 0,
      commandTimeout: 200,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    dead.on('error', () => {}); // expected: nothing listens on port 1
    const degraded = new Cache({ redis: dead, prefix, logger: log });
    let calls = 0;
    const value = await degraded.get(k('down:1'), { ttlSeconds: 60 }, async () => {
      calls++;
      return 'fresh';
    });
    expect(value).toBe('fresh');
    expect(calls).toBe(1);
    dead.disconnect();
  });

  it('[S0-07] tenant keys never collide with global or other-tenant keys', async () => {
    const a = '01a12436-c0dd-7525-a20d-1eb9eec948f6';
    const b = '01a12436-c0dd-7525-a20d-1eb9eec948f7';
    const keyA = cacheKey({ v: 1, module: 'test', entity: 'scoped', scope: { agencyId: a }, id: 'x' });
    const keyB = cacheKey({ v: 1, module: 'test', entity: 'scoped', scope: { agencyId: b }, id: 'x' });
    expect(await cache.get(keyA, { ttlSeconds: 60 }, async () => 'A')).toBe('A');
    expect(await cache.get(keyB, { ttlSeconds: 60 }, async () => 'B')).toBe('B');
  });

  it('[S0-07] misses return the same JSON shape as hits', async () => {
    const at = new Date(Date.UTC(2026, 0, 1));
    const miss = await cache.get(k('json:1'), { ttlSeconds: 60 }, async () => ({ at }));
    const hit = await cache.get(k('json:1'), { ttlSeconds: 60 }, async () => ({ at }));
    expect(miss).toEqual(hit);
    expect(typeof miss.at).toBe('string');
  });

  it('[S0-07] rejects keys not built by cacheKey()', async () => {
    await expect(cache.get('taxonomy' as CacheKey, { ttlSeconds: 60 }, async () => 1)).rejects.toThrow(/cacheKey\(\)/);
  });
});
