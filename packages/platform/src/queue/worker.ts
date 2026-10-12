import { DelayedError, type Job, UnrecoverableError, Worker } from 'bullmq';
import { isAppError } from '../errors';
import { reportError } from '../telemetry/report';
import { fairnessFor, queueFor, queueLogger, queuePrefix, queueTelemetry, workerConnection } from './connection';
import type { JobDef, StoredJob } from './jobs';

export interface PoolOptions {
  /** Jobs in flight per process. */
  concurrency?: number;
  /** First delay before a job retries when its group is at `concurrencyPerGroup`; doubles per retry. */
  groupRetryMs?: number;
  /** Longest over-cap retry delay (before jitter). */
  groupRetryMaxMs?: number;
  /** Graceful shutdown budget before in-flight jobs are abandoned (they are retried as stalled). */
  shutdownMs?: number;
}

export interface PoolHandle {
  readonly pool: string;
  readonly worker: Worker;
  /** Resolves once the schedulers of the pool's recurring jobs (`every`) are upserted. */
  readonly scheduled: Promise<void>;
  close(): Promise<void>;
}

/** Waits between scheduler upsert attempts (then gives up and reports). */
const SCHEDULE_RETRY_MS = [1_000, 5_000, 30_000, 120_000];

/**
 * Delay before the `attempt`-th (1-based) retry of a job whose group is at its cap: doubles from `baseMs`
 * up to `maxMs`, plus up to as much again as jitter. Re-delaying at a fixed interval made every waiting
 * job of a flooded group poll the cap in lockstep (S1-F3); growing delays keep the worker slots for
 * groups that can run.
 */
export function groupRetryDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random()): number {
  const backoff = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), maxMs);
  return backoff + Math.floor(random * backoff);
}

async function withRetry<T>(delays: readonly number[], fn: () => Promise<T>): Promise<T> {
  for (const delay of delays) {
    try {
      return await fn();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return fn();
}

/** Dead letters are kept this long, for inspection and manual re-enqueue. */
export const DEAD_LETTER_RETENTION_MS = 30 * 24 * 3_600_000;

/** Name of a pool's dead-letter queue. Nothing consumes it; ops inspect and re-enqueue from there. */
export const deadLetterQueue = (pool: string) => `${pool}.dead`;

/** A permanent failure: no retries, straight to the dead-letter queue. */
export { UnrecoverableError };

/** A transient failure worth retrying with backoff (any other error is retried too; this one documents intent). */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
}

function isPermanent(err: unknown): boolean {
  return err instanceof UnrecoverableError || (isAppError(err) && !err.retryable);
}

/**
 * Runs the jobs of one pool in this process (PATTERNS §12): `apps/worker` calls
 * `registerPool('indexing', [searchJobs.reindexListing, …])` for each pool in `WORKER_POOLS`.
 */
export function registerPool(pool: string, jobs: readonly JobDef[], options: PoolOptions = {}): PoolHandle {
  const byName = new Map<string, JobDef>();
  for (const def of jobs) {
    if (def.pool !== pool) throw new TypeError(`registerPool(${pool}): ${def.name} belongs to pool ${def.pool}`);
    if (byName.has(def.name)) throw new TypeError(`registerPool(${pool}): ${def.name} registered twice`);
    byName.set(def.name, def);
  }
  const log = queueLogger().child({ pool });
  const groupRetryMs = options.groupRetryMs ?? 250;
  const groupRetryMaxMs = Math.max(options.groupRetryMaxMs ?? 5_000, groupRetryMs);
  const controllers = new Set<AbortController>();
  /** Over-cap retries so far per job id (this process); cleared when the job runs, dead-letters or releases. */
  const capWaits = new Map<string, number>();

  let deadLettered = 0;
  async function deadLetter(job: Job<StoredJob>, error: string): Promise<void> {
    capWaits.delete(job.id as string);
    const dlq = queueFor(deadLetterQueue(pool));
    await dlq.add(
      job.name,
      {
        jobId: job.id,
        payload: job.data.p,
        error,
        attemptsMade: job.attemptsMade + 1,
        failedAt: new Date().toISOString(),
      },
      // Unique per failure: a stable job ID that dead-letters again later must not be dropped as a duplicate.
      { jobId: `${job.id}.${Date.now()}`, removeOnComplete: true },
    );
    // redis-queue is noeviction: trim entries older than the retention window as we go.
    if (deadLettered++ % 100 === 0) await dlq.clean(DEAD_LETTER_RETENTION_MS, 1_000, 'wait');
  }

  /** Fair-share cleanup for a job whose payload may be invalid (best effort; leftovers expire within a day). */
  async function releaseFairness(job: Job<StoredJob>, def: JobDef | undefined): Promise<void> {
    capWaits.delete(job.id as string);
    if (!def?.spec.group) return;
    let group: string;
    try {
      group = def.spec.group(job.data.p as never);
    } catch {
      return;
    }
    const fair = fairnessFor();
    await fair.done(pool, group, job.data.f ?? (job.id as string));
    if (def.spec.concurrencyPerGroup) await fair.release(pool, group, job.id as string);
  }

  async function process(job: Job<StoredJob>, token?: string): Promise<unknown> {
    const def = byName.get(job.name);
    if (!def) throw new UnrecoverableError(`no handler for ${job.name} in pool ${pool}`);
    const spec = def.spec;
    const jobLog = log.child({ job: job.name, jobId: job.id });
    const parsed = spec.payload.safeParse(job.data.p);
    if (!parsed.success) {
      await deadLetter(job, `invalid payload: ${parsed.error.message}`);
      await releaseFairness(job, def);
      throw new UnrecoverableError('invalid payload');
    }
    const group = spec.group?.(parsed.data);
    const member = job.data.f ?? (job.id as string);
    const fair = group === undefined ? undefined : fairnessFor();

    if (fair && group !== undefined && spec.concurrencyPerGroup) {
      const ok = await fair.acquire(pool, group, job.id as string, spec.concurrencyPerGroup, def.timeoutMs + 60_000);
      if (!ok) {
        const attempt = (capWaits.get(job.id as string) ?? 0) + 1;
        capWaits.set(job.id as string, attempt);
        await job.moveToDelayed(Date.now() + groupRetryDelay(attempt, groupRetryMs, groupRetryMaxMs), token);
        throw new DelayedError();
      }
    }
    capWaits.delete(job.id as string);

    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${def.timeoutMs} ms`)), def.timeoutMs);
    try {
      const result = await Promise.race([
        spec.run(parsed.data, {
          log: jobLog,
          jobId: job.id as string,
          attempt: job.attemptsMade + 1,
          progress: (value) => job.updateProgress(value),
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        }),
      ]);
      if (fair && group !== undefined) await fair.done(pool, group, member);
      return result;
    } catch (err) {
      const permanent = isPermanent(err);
      const final = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (final) {
        await deadLetter(job, message);
        if (fair && group !== undefined) await fair.done(pool, group, member);
        jobLog.error({ err, attempts: job.attemptsMade + 1 }, 'job dead-lettered');
        reportError(err, { jobId: job.id, pool, job: job.name });
      } else {
        jobLog.warn({ err, attempt: job.attemptsMade + 1 }, 'job failed; will retry');
      }
      if (permanent && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(message);
      throw err;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      if (fair && group !== undefined && spec.concurrencyPerGroup) await fair.release(pool, group, job.id as string);
    }
  }

  const connection = workerConnection();
  const worker = new Worker<StoredJob>(pool, process, {
    connection,
    prefix: queuePrefix(),
    concurrency: options.concurrency ?? 10,
    telemetry: queueTelemetry(),
  });
  worker.on('error', (err) => log.warn({ err }, 'worker error'));
  // A job that stalls past maxStalledCount is failed by BullMQ without reaching the processor's catch.
  worker.on('failed', (job, err) => {
    if (!job || !/stalled/i.test(err.message)) return;
    void Promise.all([
      deadLetter(job, `${err.name}: ${err.message}`),
      releaseFairness(job, byName.get(job.name)),
    ]).catch((cleanupErr) => log.warn({ err: cleanupErr, jobId: job.id }, 'stalled-job cleanup failed'));
  });

  // Recurring jobs: one scheduler per job, keyed by its name, so restarts and replicas upsert the same one.
  // A failed upsert (Redis blip at boot) is retried with backoff, so a recurring job never silently stops.
  const scheduled = Promise.all(
    jobs
      .filter((def) => def.spec.every !== undefined)
      .map((def) =>
        withRetry(SCHEDULE_RETRY_MS, () =>
          queueFor(pool).upsertJobScheduler(
            def.name,
            { every: def.spec.every as number },
            {
              name: def.name,
              data: { p: def.spec.payload.parse({}) } satisfies StoredJob,
              opts: {
                attempts: def.attempts,
                backoff: def.spec.backoff ?? { type: 'exponential', delay: 2_000 },
                removeOnComplete: { age: 24 * 3_600, count: 1_000 },
                removeOnFail: { age: 7 * 24 * 3_600 },
              },
            },
          ),
        ),
      ),
  ).then(
    () => undefined,
    (err: unknown) => {
      log.error({ err }, 'recurring job scheduler upsert failed');
      reportError(err, { pool });
    },
  );

  return {
    pool,
    worker,
    scheduled,
    async close() {
      const budget = options.shutdownMs ?? 30_000;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), budget);
      });
      const outcome = await Promise.race([worker.close(), timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        log.warn({ budget }, 'shutdown budget exceeded; abandoning in-flight jobs');
        for (const c of controllers) c.abort(new Error('worker shutting down'));
        await worker.close(true);
      }
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}
