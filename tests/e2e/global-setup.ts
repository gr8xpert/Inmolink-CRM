import { Redis } from 'ioredis';
import { testStackEnv } from './stack';

/**
 * Fresh rate-limit counters (runs from the same IP would otherwise add up across runs). The counters live
 * on the limits Redis (redis-queue, S1-F6), not the cache. The stack itself is prepared before Playwright
 * starts (`tests/e2e/prepare.ts`): web servers start before this runs.
 */
export default async function globalSetup(): Promise<void> {
  const redis = new Redis(testStackEnv().REDIS_LIMITS_URL ?? 'redis://localhost:56379', { lazyConnect: true });
  try {
    await redis.connect();
    // SCAN, not KEYS: the limits Redis also holds the queues.
    for await (const keys of redis.scanStream({ match: 'inl:rl:*', count: 1_000 })) {
      if ((keys as string[]).length > 0) await redis.del(...(keys as string[]));
    }
  } finally {
    redis.disconnect();
  }
}
