import { Redis } from 'ioredis';
import { testStackEnv } from './stack';

/**
 * Fresh rate-limit counters (runs from the same IP would otherwise add up across runs). The stack itself
 * is prepared before Playwright starts (`tests/e2e/prepare.ts`): web servers start before this runs.
 */
export default async function globalSetup(): Promise<void> {
  const redis = new Redis(testStackEnv().REDIS_CACHE_URL ?? 'redis://localhost:56380', { lazyConnect: true });
  try {
    await redis.connect();
    const keys = await redis.keys('inl:rl:*');
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
