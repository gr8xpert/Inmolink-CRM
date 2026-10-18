import { AppError } from '@inmolink/platform/errors';
import { defineJob, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runId, setupQueueTest, teardownQueueTest, waitFor } from './helpers';

const run = runId();
const POOL = 'test-jobs';
const handles: PoolHandle[] = [];

const runs = new Map<string, number>();
const seen: number[] = [];
const bump = (k: string) => runs.set(k, (runs.get(k) ?? 0) + 1);

const once = defineJob({
  name: 'test.once',
  pool: POOL,
  payload: z.object({ key: z.string() }),
  jobId: (p) => `once:${p.key}`,
  async run(p) {
    bump(p.key);
  },
});

const debounced = defineJob({
  name: 'test.debounced',
  pool: POOL,
  payload: z.object({ entity: z.string(), version: z.number().int() }),
  jobId: (p) => `deb:${p.entity}:${p.version}`,
  async run(p) {
    bump(`deb:${p.entity}`);
    seen.push(p.version);
  },
});

const flaky = defineJob({
  name: 'test.flaky',
  pool: POOL,
  payload: z.object({ key: z.string(), permanent: z.boolean() }),
  attempts: 3,
  backoff: { type: 'fixed', delay: 10 },
  async run(p) {
    bump(p.key);
    if (p.permanent) throw new AppError('VALIDATION_FAILED');
    throw new Error('transient');
  },
});

async function deadLetterOf(jobId: string) {
  const jobs = await queueFor(`${POOL}.dead`).getJobs(['wait']);
  return jobs.find((j) => j.data.jobId === jobId);
}

describe('queue', () => {
  beforeAll(async () => {
    await setupQueueTest(`test-${run}`);
    handles.push(registerPool(POOL, [once, debounced, flaky], { concurrency: 5 }));
  });
  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
    await teardownQueueTest([POOL]);
  });

  it('[S0-06] the same jobId enqueued twice runs once', async () => {
    const a = await once.enqueue({ key: 'k1' });
    const b = await once.enqueue({ key: 'k1' });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('test.once.once%3Ak1'); // ':' is encoded — BullMQ forbids it in custom IDs
    await waitFor(() => runs.get('k1') === 1);
    await once.enqueue({ key: 'k1' }); // after completion: still deduplicated (completed jobs kept 24 h)
    await new Promise((r) => setTimeout(r, 300));
    expect(runs.get('k1')).toBe(1);
  });

  it('[S0-06] debounced jobs collapse a burst into one run with the latest payload', async () => {
    for (let version = 1; version <= 20; version++) {
      await debounced.enqueue({ entity: 'L1', version }, { debounceMs: 300, debounceKey: 'L1' });
    }
    await waitFor(() => runs.get('deb:L1') === 1);
    await new Promise((r) => setTimeout(r, 600));
    expect(runs.get('deb:L1')).toBe(1);
    expect(seen).toEqual([20]);
  });

  it('[S5-03] throttled jobs run once per window and steady enqueues never push the run back', async () => {
    const started = Date.now();
    // An enqueue every 50 ms for 1.2 s: a debounce would never run; a 300 ms throttle runs about every window.
    for (let version = 1; Date.now() - started < 1_200; version++) {
      await debounced.enqueue({ entity: 'T1', version }, { throttleMs: 300, debounceKey: 'T1' });
      await new Promise((r) => setTimeout(r, 50));
    }
    // Several runs while enqueues kept coming, far fewer than enqueues.
    expect(runs.get('deb:T1') ?? 0).toBeGreaterThanOrEqual(2);
    expect(runs.get('deb:T1') ?? 0).toBeLessThanOrEqual(6);
  });

  it('[S0-06] transient failures retry with backoff, then land in the dead-letter queue', async () => {
    const { id } = await flaky.enqueue({ key: 'f1', permanent: false });
    await waitFor(async () => (await deadLetterOf(id)) !== undefined, 10_000);
    expect(runs.get('f1')).toBe(3);
    expect((await deadLetterOf(id))?.data).toMatchObject({ jobId: id, payload: { key: 'f1' }, attemptsMade: 3 });
  });

  it('[S0-06] a non-retryable AppError fails fast to the dead-letter queue', async () => {
    const { id } = await flaky.enqueue({ key: 'p1', permanent: true });
    await waitFor(async () => (await deadLetterOf(id)) !== undefined, 10_000);
    expect(runs.get('p1')).toBe(1);
    expect((await deadLetterOf(id))?.data.error).toContain('VALIDATION_FAILED');
  });

  it('[S0-06] invalid payloads are rejected at enqueue', async () => {
    await expect(once.enqueue({ key: 1 } as unknown as { key: string })).rejects.toThrow();
  });
});
