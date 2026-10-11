import { defineJob, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runId, setupQueueTest, teardownQueueTest } from './helpers';

const run = runId();
const POOL = 'test-schedule';
const handles: PoolHandle[] = [];

const recurring = defineJob({
  name: 'test.recurring',
  pool: POOL,
  payload: z.object({}).strict(),
  every: 60 * 60_000,
  async run() {},
});

describe('recurring jobs', () => {
  beforeAll(async () => {
    await setupQueueTest(`test-${run}`);
  });
  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
    await teardownQueueTest([POOL]);
  });

  it('[S1-F4] a pool upserts one scheduler per recurring job, also when several workers start it', async () => {
    handles.push(registerPool(POOL, [recurring]), registerPool(POOL, [recurring]));
    await Promise.all(handles.map((h) => h.scheduled));
    const schedulers = await queueFor(POOL).getJobSchedulers();
    expect(schedulers.map((s) => ({ key: s.key, every: Number(s.every) }))).toEqual([
      { key: 'test.recurring', every: 60 * 60_000 },
    ]);
  });
});
