import { closeQueues, configureQueue, deadLetterQueue, POOLS, queueFor } from '@inmolink/platform/queue';
import type { Redis } from 'ioredis';

/**
 * S15-F9: the test stack's queue Redis (redis-queue, 512 MB cap) is shared by the e2e stack (prefix `inl`) and every
 * integration suite (a random prefix per run, e.g. `test-<run>`). A suite killed before its teardown (a fork crash, a
 * timed-out gate) leaves its prefix behind — the outbox throughput suite alone leaves a 30,000-job backlog — and the
 * leftovers add up across a day of runs until Redis sits at its container's memory cap: every command then stalls,
 * BullMQ with it, and the e2e flows waiting on the worker (read-model rebuilds, e-mails) time out at random.
 *
 * `pruneStaleTestPrefixes` removes the keys of prefixes other than the stack's own whose keys were all left untouched
 * for `idleSeconds` (a running suite touches its queue keys continuously, so it is never pruned from under itself).
 * `cleanStackJobHistory` drops the stack's own finished jobs of earlier runs: production keeps completed jobs a day and
 * failed and dead-lettered ones a week (diagnosis), which on the test stack only fills the same memory.
 */

/** The e2e stack's own keys (its queues and rate-limit counters): never pruned here. */
const STACK_PREFIX = 'inl';
/** A prefix none of whose keys was read or written for this long belongs to a run that is over. */
export const STALE_PREFIX_IDLE_SECONDS = 30 * 60;
const SCAN_COUNT = 1_000;
const UNLINK_BATCH = 1_000;

export interface PruneResult {
  prefixes: number;
  keys: number;
}

export async function pruneStaleTestPrefixes(
  redis: Redis,
  idleSeconds: number = STALE_PREFIX_IDLE_SECONDS,
): Promise<PruneResult> {
  const seen = new Map<string, { keys: string[]; minIdle: number }>();
  for await (const batch of redis.scanStream({ count: SCAN_COUNT })) {
    const keys = (batch as string[]).filter((k) => {
      const at = k.indexOf(':');
      return at > 0 && k.slice(0, at) !== STACK_PREFIX;
    });
    if (keys.length === 0) continue;
    const pipe = redis.pipeline();
    for (const k of keys) pipe.object('IDLETIME', k);
    const idle = (await pipe.exec()) ?? [];
    keys.forEach((k, i) => {
      // A key gone since the scan (null) counts as just touched: its prefix is kept.
      const seconds = typeof idle[i]?.[1] === 'number' ? (idle[i]?.[1] as number) : 0;
      const prefix = k.slice(0, k.indexOf(':'));
      const entry = seen.get(prefix) ?? { keys: [], minIdle: Number.POSITIVE_INFINITY };
      entry.keys.push(k);
      entry.minIdle = Math.min(entry.minIdle, seconds);
      seen.set(prefix, entry);
    });
  }
  const result: PruneResult = { prefixes: 0, keys: 0 };
  for (const { keys, minIdle } of seen.values()) {
    if (minIdle < idleSeconds) continue;
    for (let i = 0; i < keys.length; i += UNLINK_BATCH) await redis.unlink(...keys.slice(i, i + UNLINK_BATCH));
    result.prefixes += 1;
    result.keys += keys.length;
  }
  return result;
}

/** Finished jobs this many at a time (BullMQ `clean` limit per call). */
const CLEAN_BATCH = 10_000;

/**
 * Removes the e2e stack's completed and failed jobs and its dead-letter records (earlier runs' history; the specs
 * never read it). Runs while the stack is up: the pools' waiting, delayed and active jobs are left alone.
 */
export async function cleanStackJobHistory(url: string): Promise<number> {
  await configureQueue({ url, prefix: STACK_PREFIX });
  let removed = 0;
  try {
    for (const pool of POOLS) {
      for (const [name, states] of [
        [pool, ['completed', 'failed']],
        [deadLetterQueue(pool), ['completed', 'failed', 'wait']],
      ] as const) {
        for (const state of states) {
          for (;;) {
            const ids = await queueFor(name).clean(0, CLEAN_BATCH, state);
            removed += ids.length;
            if (ids.length < CLEAN_BATCH) break;
          }
        }
      }
    }
  } finally {
    await closeQueues();
  }
  return removed;
}
