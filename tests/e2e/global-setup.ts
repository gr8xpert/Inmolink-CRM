import { cleanStackJobHistory, pruneStaleTestPrefixes } from './queue-hygiene';
import { limitsRedis, resetRateLimits } from './rate-limits';
import { testStackEnv } from './stack';

/**
 * Fresh rate-limit counters (runs from the same IP would otherwise add up across runs). The counters live
 * on the limits Redis (redis-queue, S1-F6), not the cache. The specs' `test` (`./fixtures`) resets them before every
 * test too (S15-F5). The stack itself is prepared before Playwright starts (`tests/e2e/prepare.ts`): web servers
 * start before this runs.
 *
 * S15-F9: the same Redis holds the queues; integration runs that never reached their teardown and the stack's own job
 * history are removed first, so it is not at its memory cap (stalled commands made the worker-driven flows time out at
 * random, `[S12-04]` among them).
 */
export default async function globalSetup(): Promise<void> {
  const redis = limitsRedis();
  try {
    await redis.connect();
    const pruned = await pruneStaleTestPrefixes(redis);
    const history = await cleanStackJobHistory(testStackEnv().REDIS_QUEUE_URL ?? 'redis://localhost:56379');
    console.log(
      `queue Redis: removed ${pruned.keys} keys of ${pruned.prefixes} finished integration runs and ${history} finished jobs of earlier e2e runs`,
    );
    await resetRateLimits(redis);
  } finally {
    redis.disconnect();
  }
}
