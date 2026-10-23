import { defineJob, producerConnection } from '@inmolink/platform/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runId, setupQueueTest, teardownQueueTest } from './helpers';

const run = runId();
const POOL = 'test-autopipe';

const grouped = defineJob({
  name: 'test.autopipeGrouped',
  pool: POOL,
  payload: z.object({ group: z.string(), i: z.number() }),
  group: (p) => p.group,
  async run() {},
});

/**
 * S10-F11: the producer connection auto-pipelines, and ioredis builds each auto-pipeline with the custom (Lua) commands
 * defined on the client at that moment. The fair-share script used to be defined lazily, on the first `fairnessFor()`;
 * a pipeline already open on the producer then (another caller's command in the same tick, or one queued behind an
 * in-flight pipeline) had no `inlFairEnqueueMany`: `pipeline[functionName] is not a function`, plus an uncaught
 * `results[i] is not iterable` when that pipeline replied.
 */
describe('queue producer auto-pipelining', () => {
  beforeAll(() => setupQueueTest(`test-${run}`));
  afterAll(() => teardownQueueTest([POOL]));

  it('[S10-F11] the first fair-share enqueue of a process works while a producer auto-pipeline is already open', async () => {
    // A fresh producer (setupQueueTest reconfigured the queue): no fair-share bookkeeping has run yet. This command opens
    // the producer's auto-pipeline for this tick, before anything has asked for the fair-share script.
    const ping = producerConnection().ping();
    // Same tick: enqueueMany reaches the fair-share script synchronously, so it is appended to that open pipeline.
    const [result] = await grouped.enqueueMany([
      { payload: { group: 'g1', i: 1 } },
      { payload: { group: 'g2', i: 2 } },
    ]);
    expect(await ping).toBe('PONG');
    expect(result?.id).toBeTruthy();
  });
});
