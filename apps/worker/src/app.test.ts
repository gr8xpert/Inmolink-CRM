import { loadConfig } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { describe, expect, it } from 'vitest';
import { startWorker } from './app';
import { POOLS, workerEnv } from './config';

const pools = (WORKER_POOLS?: string) => loadConfig({ WORKER_POOLS: workerEnv.WORKER_POOLS }, { WORKER_POOLS });

describe('worker app', () => {
  it('[S0-08] WORKER_POOLS selects pools by name; unknown names fail boot', () => {
    expect(pools().WORKER_POOLS).toEqual([...POOLS]);
    expect(pools('imports, media,imports').WORKER_POOLS).toEqual(['imports', 'media']);
    expect(() => pools('imports,nope')).toThrow(/comma list/);
  });

  it('[S0-08] worker boots its health server; pools without jobs are not started', async () => {
    const worker = await startWorker({
      logger: createLogger({ level: 'silent' }),
      pools: ['imports'],
      jobs: {},
      trustProxy: false,
      checks: { redisQueue: async () => {} },
    });
    expect(worker.handles).toHaveLength(0);
    expect((await worker.health.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    await worker.drain();
  });

  it('[S0-08] the outbox pool needs a dispatcher', async () => {
    await expect(
      startWorker({
        logger: createLogger({ level: 'silent' }),
        pools: ['outbox'],
        jobs: {},
        trustProxy: false,
        checks: {},
      }),
    ).rejects.toThrow(/createDispatcher/);
  });
});
