import { Redis } from 'ioredis';
import { testStackEnv } from './stack';

/** The limits Redis of the test stack (redis-queue, S1-F6), not connected yet. */
export function limitsRedis(): Redis {
  return new Redis(testStackEnv().REDIS_LIMITS_URL ?? 'redis://localhost:56379', { lazyConnect: true });
}

/** Deletes every rate-limit counter (`inl:rl:*`). SCAN, not KEYS: the limits Redis also holds the queues. */
export async function resetRateLimits(redis: Redis): Promise<void> {
  for await (const keys of redis.scanStream({ match: 'inl:rl:*', count: 1_000 })) {
    if ((keys as string[]).length > 0) await redis.del(...(keys as string[]));
  }
}
