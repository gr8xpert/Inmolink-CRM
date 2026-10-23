import { createHash } from 'node:crypto';
import type { JobsOptions } from 'bullmq';
import type { z } from 'zod';
import { newId } from '../ids';
import type { Logger } from '../logger';
import { addBatched, addBulkFair } from './batcher';
import { fairnessFor, queueFor, queuePrefix, traceMetadata } from './connection';
import type { BacklogEntry } from './fairness';

export interface JobContext {
  log: Logger;
  jobId: string;
  /** 1 on the first run. */
  attempt: number;
  progress(value: number | object): Promise<void>;
  /** Aborted when the job's `timeoutMs` elapses or the worker shuts down. */
  signal: AbortSignal;
  /**
   * S9 review: hands back the job's per-process and pool-wide cap slots (its `capGroup`'s, or its definition's) before
   * it returns, once its heavy part is done — e.g. before it enqueues a successor that needs the same slot. The group
   * lease (`concurrencyPerGroup`) is kept until the job ends. Idempotent; absent outside a worker (direct `run` calls).
   */
  releaseCapSlots?: () => Promise<void>;
}

export interface JobSpec<S extends z.ZodType> {
  /** `<module>.<action>`; unique across pools. */
  name: string;
  /** Worker pool = BullMQ queue (workers.md lists the pools). */
  pool: string;
  payload: S;
  /** Stable ID: enqueueing the same ID again while the job exists (or for 24 h after it completes) is a no-op. */
  jobId?: (payload: z.output<S>) => string;
  /** Fair-share key, normally the agency ID. */
  group?: (payload: z.output<S>) => string;
  /** Max jobs of one group running at once in this pool (needs `group`). */
  concurrencyPerGroup?: number;
  /**
   * Max jobs of this definition running at once across every worker process of the pool (S6-08): a lease set like
   * the group cap, so other jobs of the same pool keep their slots (BullMQ's queue-wide `setGlobalConcurrency`
   * would cap them too). A function is read per attempt (configuration set at boot). A job over the cap goes back
   * to delayed, keeping its priority.
   */
  globalConcurrency?: number | (() => number);
  /**
   * Max jobs of this definition running at once in one worker process (S6 review): bounds the memory a heavy job
   * kind can take in a process whose pool runs `concurrency` jobs of every kind. Counted in memory, no Redis. A job
   * over the cap goes back to delayed like one over `globalConcurrency`; another process can take it meanwhile.
   */
  perProcessConcurrency?: number | (() => number);
  /**
   * S9 review: a cap shared with the pool's other definitions of the same `capGroup`. `perProcessConcurrency` and
   * `globalConcurrency` then count the running jobs of every definition of the group (in this process / across the
   * pool), not of this definition alone, so several heavy job kinds of one pool cannot each take their own slots. Each
   * definition compares the group's count with its own caps: definitions of one group normally declare the same.
   */
  capGroup?: string;
  /** Total runs including the first. Default 5. */
  attempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
  /** Aborts `ctx.signal` and fails the attempt. Default 10 minutes. */
  timeoutMs?: number;
  /**
   * Recurring job (maintenance, S1-F4): the pool's workers keep one BullMQ job scheduler that adds this
   * job every `every` ms (≥ 1 minute) with an empty payload, so the payload schema must accept `{}`.
   * Upserted at pool start; several processes upserting the same scheduler is harmless. Renaming or
   * removing a recurring job leaves its old scheduler in Redis: remove it with `removeJobScheduler`.
   */
  every?: number;
  run(payload: z.output<S>, ctx: JobContext): Promise<unknown>;
}

export interface EnqueueOptions {
  /** Collapse bursts: the job runs once, `debounceMs` after the last enqueue, with the latest payload. */
  debounceMs?: number;
  /** Debounce key; defaults to the stable job ID, else the payload hash. */
  debounceKey?: string;
  /**
   * Throttle (S5-03): the first enqueue runs `throttleMs` later; enqueues until then are dropped (the queued run
   * sees their work). Unlike a debounce, steady enqueues never push the run back. Keyed like `debounceKey`.
   */
  throttleMs?: number;
  delayMs?: number;
}

export interface EnqueueResult {
  /** BullMQ job ID (for a debounced burst, the ID of the job that will run). */
  id: string;
}

export interface JobDef<S extends z.ZodType = z.ZodType>
  extends Readonly<Required<Pick<JobSpec<S>, 'name' | 'pool' | 'attempts' | 'timeoutMs'>>> {
  readonly spec: JobSpec<S>;
  enqueue(payload: z.input<S>, options?: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Enqueues many jobs in bulk (S8-F1): the same semantics per entry as `enqueue` (stable IDs, debounce, throttle,
   * fair share), but one fair-share pipeline and one BullMQ `addBulk` per 500 entries (`addBulkFair`) instead of
   * round trips per job — for fan-outs and sweeps. Results in entry order.
   */
  enqueueMany(entries: readonly { payload: z.input<S>; options?: EnqueueOptions }[]): Promise<EnqueueResult[]>;
}

/** Job data in Redis: the payload plus the fairness backlog member. */
export interface StoredJob {
  p: unknown;
  f?: string;
}

const NAME = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const POOL = /^[a-z][a-z0-9-]{0,31}$/;
const CAP_GROUP = /^[a-z][a-zA-Z0-9.-]{0,63}$/;

/** BullMQ custom IDs must not contain ':' or be purely numeric; the job-name prefix rules out the latter. */
export function stableJobId(name: string, id: string): string {
  return `${name}.${id.replaceAll('%', '%25').replaceAll(':', '%3A')}`;
}

/** workers.md: payloads carry IDs and small parameters only. */
export const MAX_PAYLOAD_BYTES = 10_240;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);

/**
 * Defines a background job (PATTERNS §12). Payloads are IDs and small parameters (< 10 KB);
 * the job loads its data. Handlers must be idempotent — a job can run more than once.
 */
export function defineJob<S extends z.ZodType>(spec: JobSpec<S>): JobDef<S> {
  if (!NAME.test(spec.name)) throw new TypeError(`defineJob: invalid name ${JSON.stringify(spec.name)}`);
  if (!POOL.test(spec.pool)) throw new TypeError(`defineJob: invalid pool ${JSON.stringify(spec.pool)}`);
  if (spec.concurrencyPerGroup !== undefined && !spec.group) {
    throw new TypeError(`defineJob ${spec.name}: concurrencyPerGroup needs group`);
  }
  if (
    typeof spec.globalConcurrency === 'number' &&
    (!Number.isInteger(spec.globalConcurrency) || spec.globalConcurrency < 1)
  ) {
    throw new RangeError(`defineJob ${spec.name}: globalConcurrency must be a positive integer`);
  }
  if (
    typeof spec.perProcessConcurrency === 'number' &&
    (!Number.isInteger(spec.perProcessConcurrency) || spec.perProcessConcurrency < 1)
  ) {
    throw new RangeError(`defineJob ${spec.name}: perProcessConcurrency must be a positive integer`);
  }
  if (spec.capGroup !== undefined) {
    if (!CAP_GROUP.test(spec.capGroup)) {
      throw new TypeError(`defineJob ${spec.name}: invalid capGroup ${JSON.stringify(spec.capGroup)}`);
    }
    if (spec.perProcessConcurrency === undefined && spec.globalConcurrency === undefined) {
      throw new TypeError(`defineJob ${spec.name}: capGroup needs perProcessConcurrency or globalConcurrency`);
    }
  }
  const attempts = spec.attempts ?? 5;
  const timeoutMs = spec.timeoutMs ?? 10 * 60_000;
  if (spec.every !== undefined) {
    if (!Number.isInteger(spec.every) || spec.every < 60_000) {
      throw new RangeError(`defineJob ${spec.name}: every must be an integer ≥ 60000 ms`);
    }
    if (!spec.payload.safeParse({}).success) {
      throw new TypeError(`defineJob ${spec.name}: a recurring job's payload schema must accept {}`);
    }
  }

  /** A job as BullMQ adds it: payload checked, IDs, deduplication and the fair-share entry (priority set later). */
  function prepare(input: z.input<S>, options: EnqueueOptions) {
    const payload = spec.payload.parse(input) as z.output<S>;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new TypeError(
        `${spec.name}: payload is ${bytes} bytes (max ${MAX_PAYLOAD_BYTES}); pass IDs and load data in the job`,
      );
    }
    const group = spec.group?.(payload);
    const stable = spec.jobId ? stableJobId(spec.name, spec.jobId(payload)) : undefined;
    const throttled = options.throttleMs !== undefined && options.throttleMs > 0;
    if (throttled && options.debounceMs)
      throw new TypeError(`${spec.name}: debounceMs and throttleMs exclude each other`);
    const debounced = throttled || (options.debounceMs !== undefined && options.debounceMs > 0);
    // A debounced burst replaces its delayed job, so each enqueue needs a fresh ID.
    const jobId = debounced || !stable ? newId() : stable;
    // Scoped to the group (tenant): one tenant's debounce key can never replace another tenant's job.
    const debounceKey = options.debounceKey ?? spec.jobId?.(payload) ?? hash(payload);
    const dedupId = debounced
      ? stableJobId(spec.name, group === undefined ? debounceKey : `${group}.${debounceKey}`)
      : undefined;

    const opts: JobsOptions = {
      jobId,
      attempts,
      backoff: spec.backoff ?? { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 3_600, count: 50_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    };
    // No caller span: a fresh trace — never the context of whoever flushes the batch.
    const metadata = traceMetadata();
    opts.telemetry = metadata ? { metadata } : { omitContext: true };
    const data: StoredJob = { p: payload };
    let fair: BacklogEntry | undefined;
    if (group !== undefined) {
      const member = dedupId ?? jobId;
      data.f = member;
      // If the stable job already exists, BullMQ ignores the add: do not count it in the backlog.
      fair = { group, member, existingJobKey: debounced ? undefined : `${queuePrefix()}:${spec.pool}:${jobId}` };
    }
    if (throttled) {
      opts.deduplication = { id: dedupId as string, ttl: options.throttleMs };
      opts.delay = options.throttleMs;
    } else if (debounced) {
      opts.deduplication = { id: dedupId as string, ttl: options.debounceMs, extend: true, replace: true };
      opts.delay = options.debounceMs;
    } else if (options.delayMs) {
      opts.delay = options.delayMs;
    }
    return { jobId, opts, data, fair, debounced };
  }

  async function enqueue(input: z.input<S>, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const { jobId, opts, data, fair, debounced } = prepare(input, options);
    if (debounced) {
      if (fair) opts.priority = await fairnessFor().priorityFor(spec.pool, fair);
      const job = await queueFor(spec.pool).add(spec.name, data, opts);
      return { id: job.id ?? jobId };
    }
    return { id: await addBatched(spec.pool, spec.name, data, opts, fair) };
  }

  async function enqueueMany(
    entries: readonly { payload: z.input<S>; options?: EnqueueOptions }[],
  ): Promise<EnqueueResult[]> {
    // Every payload is checked before anything is added: one bad entry adds none.
    const prepared = entries.map((e) => prepare(e.payload, e.options ?? {}));
    const ids = await addBulkFair(
      spec.pool,
      prepared.map((p) => ({ name: spec.name, data: p.data, opts: p.opts, fair: p.fair })),
    );
    return ids.map((id) => ({ id }));
  }

  return { name: spec.name, pool: spec.pool, attempts, timeoutMs, spec, enqueue, enqueueMany };
}
