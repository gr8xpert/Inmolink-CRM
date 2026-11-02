import { closeDb } from '@inmolink/core';
import { setupTestDb } from '@inmolink/db/testing';
import { closeCache } from '@inmolink/platform/cache';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, defineJob, queueFor } from '@inmolink/platform/queue';
import { gracefulShutdown } from '@inmolink/platform/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startWorker } from './app';

const logger = createLogger({ level: 'silent' });
const prefix = `drain${Date.now().toString(36)}`;

beforeAll(async () => {
  await setupTestDb('worker'); // brings the test stack up when needed
  await configureQueue({ prefix, logger });
}, 120_000);

afterAll(async () => {
  for (const name of ['imports', 'imports.dead']) await queueFor(name).obliterate({ force: true });
  await closeQueues();
  await closeCache();
  await closeDb();
});

describe('worker shutdown', () => {
  it('[S0-08] SIGTERM drains in-flight jobs within 30 s', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const finished: string[] = [];
    const slowJob = defineJob({
      name: 'test.slowImport',
      pool: 'imports',
      payload: z.object({ id: z.string() }),
      jobId: (p) => `slow:${p.id}`,
      async run(p) {
        started();
        await new Promise((r) => setTimeout(r, 1_500));
        finished.push(p.id);
      },
    });

    const worker = await startWorker({
      logger,
      pools: ['imports'],
      jobs: { imports: [slowJob] },
      trustProxy: false,
      checks: {},
    });
    const exit = vi.fn();
    const shutdown = gracefulShutdown({
      logger,
      signals: ['SIGTERM'],
      exit,
      steps: [
        { name: 'pools', run: worker.drain },
        { name: 'queue', run: closeQueues },
      ],
    });
    try {
      await slowJob.enqueue({ id: 'a' });
      await running;
      const t0 = Date.now();
      process.emit('SIGTERM');
      await shutdown.shutdown('SIGTERM'); // the run the signal started
      expect(finished).toEqual(['a']); // finished, not abandoned
      expect(exit).toHaveBeenCalledWith(0);
      expect(Date.now() - t0).toBeLessThan(30_000);
    } finally {
      shutdown.dispose();
      await configureQueue({ prefix, logger }); // reopen for afterAll cleanup
    }
  }, 60_000);
});

describe('retired job schedulers (S17-F4)', () => {
  it('[S17-F4] a pool start removes the BullMQ scheduler of a retired recurring job (idempotent)', async () => {
    const retired = 'test.retiredHourly';
    const queue = queueFor('imports');
    await queue.upsertJobScheduler(retired, { every: 3_600_000 }, { name: retired, data: { p: {} } });
    expect(await queue.getJobScheduler(retired)).toBeTruthy();
    const keep = defineJob({ name: 'test.keepImport', pool: 'imports', payload: z.object({}), async run() {} });
    const start = () =>
      startWorker({
        logger,
        pools: ['imports'],
        jobs: { imports: [keep] },
        trustProxy: false,
        checks: {},
        retiredSchedulers: { imports: [retired] },
      });
    const worker = await start();
    await vi.waitFor(async () => expect(await queue.getJobScheduler(retired)).toBeFalsy(), { timeout: 10_000 });
    await worker.drain();
    // Already gone: a second start removes nothing and does not fail.
    const again = await start();
    await again.drain();
    expect(await queue.getJobScheduler(retired)).toBeFalsy();
  }, 60_000);
});
