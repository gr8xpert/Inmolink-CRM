import { metrics } from '@opentelemetry/api';
import { DelayedError, type Job, UnrecoverableError, Worker } from 'bullmq';
import { isAppError } from '../errors';
import { sanitizeError } from '../logger';
import { QUEUE_WAIT_METRIC } from '../telemetry/names';
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

/** Group and pool-wide cap slots are leased this long and renewed every `SLOT_RENEW_MS` while the job runs. */
export const SLOT_LEASE_MS = 2 * 60_000;
const SLOT_RENEW_MS = 30_000;

/** A job definition's pool-wide or per-process cap, read per attempt; undefined when it has none. */
function capOf(cap: number | (() => number) | undefined): number | undefined {
  if (cap === undefined) return undefined;
  const n = typeof cap === 'function' ? cap() : cap;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * The key a definition's per-process and pool-wide caps are counted under: its `capGroup` (shared with the pool's other
 * definitions of that group, S9 review) or its own name. `@` cannot start a job name, so a group never collides with one.
 */
const capKeyOf = (spec: { name: string; capGroup?: string }): string =>
  spec.capGroup === undefined ? spec.name : `@${spec.capGroup}`;

/**
 * S11 review: how long a job waited past its due time (enqueue + its requested delay) before its first attempt started,
 * in ms; undefined for a retry (its backoff is intended). `opts.delay` is the requested delay — an over-cap bounce
 * (`moveToDelayed`) changes only the job's `delay` field, so bounces count as waiting.
 */
export function queueWaitMs(
  job: Pick<Job, 'timestamp' | 'attemptsMade'> & { opts: { delay?: number } },
  now = Date.now(),
): number | undefined {
  if (job.attemptsMade > 0) return undefined;
  return Math.max(0, now - job.timestamp - (job.opts.delay ?? 0));
}

/**
 * `inmolink_queue_wait_seconds{pool}` (alerts: infra/monitoring/rules/queues.yml). Created per pool at registration,
 * after the app has set its meter provider (the metrics API has no proxy: a meter taken at import would be a no-op).
 */
const queueWaitHistogram = () =>
  metrics.getMeter('@inmolink/platform').createHistogram(QUEUE_WAIT_METRIC, {
    description: 'Seconds a job waited in its pool queue past its due time before its first attempt ran, by pool',
  });

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

/** Whether the worker fails this error for good (no retry): an `UnrecoverableError` or a non-retryable `AppError`. */
export function isPermanent(err: unknown): boolean {
  return err instanceof UnrecoverableError || (isAppError(err) && !err.retryable);
}

/**
 * Whether this error is a foreign-key violation against a deleted agency (S12-F24): a tenant job whose agency was
 * pruned or deleted while the job waited. Retrying cannot help; the job's work no longer exists.
 */
export function isMissingAgencyError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    const { code, detail, constraint } = e as { code?: unknown; detail?: unknown; constraint?: unknown };
    if (code === '23503') {
      if (
        typeof detail === 'string' &&
        /Key \([a-z_]*agency_id\)=\(.*\) is not present in table "agencies"/.test(detail)
      ) {
        return true;
      }
      if (typeof constraint === 'string' && /agency_id_agencies_id_fk$/.test(constraint)) return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
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
  const queueWait = queueWaitHistogram();
  const groupRetryMs = options.groupRetryMs ?? 250;
  const groupRetryMaxMs = Math.max(options.groupRetryMaxMs ?? 5_000, groupRetryMs);
  const controllers = new Set<AbortController>();
  /** Over-cap retries so far per job id (this process); cleared when the job runs, dead-letters or releases. */
  const capWaits = new Map<string, number>();
  /** Jobs of each definition (or cap group) running in this process now (`perProcessConcurrency`). */
  const localRunning = new Map<string, number>();

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
    if (def && capOf(def.spec.globalConcurrency) !== undefined) {
      await fairnessFor().releaseCap(pool, capKeyOf(def.spec), job.id as string);
    }
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

    // S6-08 review: short slot leases renewed while the job runs, so a crashed process frees its group and cap slots
    // within minutes, not after the job's whole timeout.
    const leaseMs = SLOT_LEASE_MS;
    const overCap = async (): Promise<never> => {
      const attempt = (capWaits.get(job.id as string) ?? 0) + 1;
      capWaits.set(job.id as string, attempt);
      await job.moveToDelayed(Date.now() + groupRetryDelay(attempt, groupRetryMs, groupRetryMaxMs), token);
      throw new DelayedError();
    };
    // S6 review: the per-process cap first — checked and taken with no await in between, so two jobs of this
    // process cannot both pass it; handed back if a group or pool-wide cap then sends the job back to delayed.
    // S9 review: counted per cap group when the definition has one (several heavy job kinds share the slots).
    const capKey = capKeyOf(spec);
    const perProcess = capOf(spec.perProcessConcurrency);
    if (perProcess !== undefined) {
      if ((localRunning.get(capKey) ?? 0) >= perProcess) await overCap();
      localRunning.set(capKey, (localRunning.get(capKey) ?? 0) + 1);
    }
    let localHeld = perProcess !== undefined;
    const releaseLocal = () => {
      if (!localHeld) return;
      localHeld = false;
      localRunning.set(capKey, (localRunning.get(capKey) ?? 1) - 1);
    };
    let globalCap: number | undefined;
    /** Holds a pool-wide cap slot; false once handed back (the job ended, or `releaseCapSlots`). */
    let globalHeld = false;
    try {
      if (fair && group !== undefined && spec.concurrencyPerGroup) {
        const ok = await fair.acquire(pool, group, job.id as string, spec.concurrencyPerGroup, leaseMs);
        if (!ok) await overCap();
      }
      // S6-08: the definition's pool-wide cap, taken after the group's slot (and that one handed back when full).
      globalCap = capOf(spec.globalConcurrency);
      if (globalCap !== undefined) {
        const ok = await fairnessFor().acquireCap(pool, capKey, job.id as string, globalCap, leaseMs);
        if (!ok) {
          if (fair && group !== undefined && spec.concurrencyPerGroup) {
            await fair.release(pool, group, job.id as string);
          }
          await overCap();
        }
        globalHeld = true;
      }
    } catch (err) {
      releaseLocal();
      throw err;
    }
    capWaits.delete(job.id as string);
    const waitedMs = queueWaitMs(job);
    if (waitedMs !== undefined) queueWait.record(waitedMs / 1_000, { pool });
    const holdsGroup = Boolean(fair && group !== undefined && spec.concurrencyPerGroup);
    const releaseGlobal = async () => {
      if (!globalHeld) return;
      globalHeld = false;
      await fairnessFor().releaseCap(pool, capKey, job.id as string);
    };
    const renew =
      holdsGroup || globalCap !== undefined
        ? setInterval(() => {
            const renewals: Promise<unknown>[] = [];
            if (holdsGroup) {
              renewals.push(
                fairnessFor().acquire(
                  pool,
                  group as string,
                  job.id as string,
                  spec.concurrencyPerGroup as number,
                  leaseMs,
                ),
              );
            }
            if (globalHeld) {
              renewals.push(fairnessFor().acquireCap(pool, capKey, job.id as string, globalCap as number, leaseMs));
            }
            Promise.all(renewals).catch((err: unknown) => jobLog.warn({ err }, 'slot lease renewal failed'));
          }, SLOT_RENEW_MS)
        : undefined;
    renew?.unref();

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
          releaseCapSlots: async () => {
            releaseLocal();
            await releaseGlobal();
          },
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        }),
      ]);
      if (fair && group !== undefined) await fair.done(pool, group, member);
      return result;
    } catch (err) {
      // S12-F24: a tenant job whose agency no longer exists finishes (no retry, no dead letter): nothing is left to do.
      if (group !== undefined && isMissingAgencyError(err)) {
        jobLog.warn({ agencyGroup: group }, 'agency no longer exists: job skipped');
        if (fair) await fair.done(pool, group, member);
        return { skipped: 'agency-gone' };
      }
      // S10-01 review: a failed query's bound values never reach the DLQ, BullMQ's failedReason, logs or reports.
      sanitizeError(err);
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
      if (renew) clearInterval(renew);
      controllers.delete(controller);
      releaseLocal();
      if (fair && group !== undefined && spec.concurrencyPerGroup) await fair.release(pool, group, job.id as string);
      // Unconditional (idempotent): a renewal in flight when `releaseCapSlots` ran may have put the slot back.
      globalHeld = false;
      if (globalCap !== undefined) await fairnessFor().releaseCap(pool, capKey, job.id as string);
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
      deadLetter(job, `${err.name}: ${sanitizeError(err).message}`),
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
