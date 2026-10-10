import type { Redis } from 'ioredis';

/** Connections that have been ready at least once: after that, "not ready" means an outage. */
const seenReady = new WeakSet<Redis>();

/**
 * Fails fast when redis-cache is down: the connection runs without an offline queue, so commands
 * on a dead connection would fail anyway. It waits (briefly) only for a connection that has never
 * been ready — the first requests after boot — never for one reconnecting after an outage.
 */
export async function whenReady(redis: Redis, startupWaitMs = 1_000): Promise<void> {
  if (redis.status === 'ready') {
    seenReady.add(redis);
    return;
  }
  const starting = redis.status === 'wait' || redis.status === 'connecting' || redis.status === 'connect';
  if (!starting || seenReady.has(redis)) throw new Error(`redis-cache not ready (${redis.status})`);
  if (redis.status === 'wait') redis.connect().catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      if (err) reject(err);
      else resolve();
    };
    const onReady = () => {
      seenReady.add(redis);
      done();
    };
    const timer = setTimeout(() => done(new Error('redis-cache not ready (startup timeout)')), startupWaitMs);
    redis.on('ready', onReady);
  });
}
