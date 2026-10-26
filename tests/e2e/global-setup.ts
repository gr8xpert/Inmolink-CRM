import { limitsRedis, resetRateLimits } from './rate-limits';

/**
 * Fresh rate-limit counters (runs from the same IP would otherwise add up across runs). The counters live
 * on the limits Redis (redis-queue, S1-F6), not the cache. The specs' `test` (`./fixtures`) resets them before every
 * test too (S15-F5). The stack itself is prepared before Playwright starts (`tests/e2e/prepare.ts`): web servers
 * start before this runs.
 */
export default async function globalSetup(): Promise<void> {
  const redis = limitsRedis();
  try {
    await redis.connect();
    await resetRateLimits(redis);
  } finally {
    redis.disconnect();
  }
}
