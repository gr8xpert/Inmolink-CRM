// Marker jobs for the redis-queue drills (S16-02): idempotent no-op jobs in a pool of their own, recording which ran.
// Local drills run them on the test stack; the staging drill on the real redis-queue under a drill-only key prefix
// (`configureQueue({ prefix })`), so the staging workers never see them. The drill process is their only worker.
import { defineJob, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { z } from 'zod';

export interface MarkerJobs {
  pool: string;
  /** key → times run (> 1 = a redelivery: allowed, jobs are idempotent). */
  ran: Map<string, number>;
  enqueue(keys: readonly string[]): Promise<void>;
  startWorker(concurrency?: number): void;
  lost(keys: readonly string[]): string[];
  duplicates(): number;
  /** Entries in the pool's dead-letter queue. */
  deadLetters(): Promise<number>;
  /** Stops the worker and removes both queues. */
  close(): Promise<void>;
}

/** `tag`: letters and digits, unique per run (it names the pool, the job and its IDs). */
export function markerJobs(tag: string, runMs = 20): MarkerJobs {
  if (!/^[a-z][a-z0-9]{0,40}$/.test(tag)) throw new TypeError(`marker tag must be lowercase letters/digits: ${tag}`);
  const pool = `chaos-${tag}`;
  const ran = new Map<string, number>();
  const job = defineJob({
    name: `test.chaos.${tag}`,
    pool,
    payload: z.object({ key: z.string() }),
    jobId: (p) => `chaos:${p.key}`,
    async run(p) {
      await new Promise((res) => setTimeout(res, runMs));
      ran.set(p.key, (ran.get(p.key) ?? 0) + 1);
    },
  });
  let handle: PoolHandle | undefined;
  return {
    pool,
    ran,
    async enqueue(keys) {
      for (const key of keys) await job.enqueue({ key });
    },
    startWorker(concurrency = 2) {
      handle ??= registerPool(pool, [job], { concurrency });
    },
    lost: (keys) => keys.filter((k) => !ran.has(k)),
    duplicates: () => [...ran.values()].reduce((a, n) => a + n - 1, 0),
    async deadLetters() {
      const counts = await queueFor(`${pool}.dead`).getJobCounts('wait', 'delayed', 'completed', 'failed');
      return Object.values(counts).reduce((a, b) => a + b, 0);
    },
    async close() {
      await handle?.close();
      for (const name of [pool, `${pool}.dead`]) await queueFor(name).obliterate({ force: true });
    },
  };
}
