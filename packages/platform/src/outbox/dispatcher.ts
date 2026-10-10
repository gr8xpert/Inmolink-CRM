import { SpanStatusCode } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import type { Logger } from '../logger';
import { withConsumerSpan } from '../telemetry/context';
import type { SqlExecutor } from './emit';
import { defaultSubscribers, type EventMeta, type SubscriberRegistry } from './events';

/** `withSystem` from `@inmolink/db`, injected so platform does not depend on db. */
export type RunSystem = <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

/** `(onNotify) => listen(OUTBOX_CHANNEL, onNotify)` from `@inmolink/db`. */
export type ListenFn = (onNotify: () => void) => Promise<{ close(): Promise<void> }>;

export interface DispatcherOptions {
  runSystem: RunSystem;
  /** Wake-up on commit. Without it the dispatcher only polls. */
  listen?: ListenFn;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  subscribers?: SubscriberRegistry;
  /** Rows claimed per round. */
  batchSize?: number;
  /**
   * Claim → deliver → ack loops per process. Several overlap one batch's database round trips with the
   * next batch's Redis fan-out; more dispatcher processes scale further (SKIP LOCKED keeps them apart).
   */
  lanes?: number;
  /** Subscriber calls in flight per batch. */
  concurrency?: number;
  /** Delivering one event (all its subscribers) slower than this counts as failed — a hung dependency must not stall the batch. */
  deliveryTimeoutMs?: number;
  /** A claimed row is invisible to other dispatchers this long; a crash mid-batch redelivers after it. */
  leaseMs?: number;
  /** Idle poll interval (fallback when a NOTIFY is missed or LISTEN is unavailable). */
  pollMs?: number;
  /** Attempts before an event is dead-lettered (`dead_at`), replayable with `scripts/ops/replay-outbox.ts`. */
  maxAttempts?: number;
  /** Retry delay after failed attempt `n` (1-based). */
  backoffMs?: (attempt: number) => number;
  /** Processed (not dead) rows older than this are deleted. */
  retentionMs?: number;
  /** Dead-lettered rows are kept this long for replay, then deleted (payloads are IDs, but keep nothing forever). */
  deadRetentionMs?: number;
  pruneEveryMs?: number;
}

export interface DispatchStats {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

export interface Dispatcher {
  start(): Promise<void>;
  /** Stops claiming, waits for the batch in flight. */
  stop(): Promise<void>;
  /** One claim → deliver → acknowledge round. */
  runOnce(): Promise<DispatchStats>;
  /** Deletes processed rows past retention, in batches. Returns rows deleted. */
  prune(): Promise<number>;
}

interface ClaimedRow {
  id: string;
  agency_id: string;
  type: string;
  version: number;
  payload: unknown;
  attempts: number;
  created_at: Date | string;
  trace_parent: string | null;
}

interface Outcome {
  id: string;
  /** `attempts` at claim time: the ack only applies if no other dispatcher re-claimed the row since. */
  attempts: number;
  delayMs?: number;
  error?: string;
}

const PRUNE_BATCH = 5_000;
const MAX_ERROR_LENGTH = 2_000;

const defaultBackoff = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 300_000);

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`delivery timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Outbox dispatcher (PATTERNS §8, worker pool `outbox`). Each round:
 *   1. claim — one short `withSystem` transaction leases up to `batchSize` due rows
 *      (`FOR UPDATE SKIP LOCKED`, so several dispatchers never take the same row);
 *   2. deliver — subscribers run outside any transaction (they enqueue jobs over the network);
 *   3. acknowledge — one transaction marks successes processed and schedules retries / dead letters.
 * Delivery is at least once: a crash between 2 and 3 redelivers after the lease expires.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const {
    runSystem,
    logger,
    subscribers = defaultSubscribers,
    batchSize = 500,
    lanes = 4,
    concurrency = 200,
    deliveryTimeoutMs = 15_000,
    leaseMs = 60_000,
    pollMs = 1_000,
    maxAttempts = 10,
    backoffMs = defaultBackoff,
    retentionMs = 7 * 24 * 3_600_000,
    deadRetentionMs = 30 * 24 * 3_600_000,
    pruneEveryMs = 10 * 60_000,
  } = options;

  // A batch delivers in ceil(batch / concurrency) waves of at most deliveryTimeoutMs each; the lease
  // must outlast that, or another dispatcher re-claims rows still being delivered.
  const worstBatchMs = Math.ceil(batchSize / concurrency) * deliveryTimeoutMs;
  if (leaseMs <= worstBatchMs) {
    throw new RangeError(
      `createDispatcher: leaseMs (${leaseMs}) must exceed the worst-case batch time (${worstBatchMs} ms)`,
    );
  }

  let running = false;
  let loops: Promise<void>[] = [];
  let listener: { close(): Promise<void> } | undefined;
  // Bumped by every NOTIFY; a lane that saw a bump since its last claim skips its idle sleep.
  let generation = 0;
  const wakers = new Set<() => void>();

  const signal = () => {
    generation++;
    for (const wake of [...wakers]) wake();
  };

  const sleep = (ms: number, seen: number) =>
    new Promise<void>((resolve) => {
      if (generation !== seen || !running) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      }
      wakers.add(done);
    });

  async function claim(): Promise<ClaimedRow[]> {
    const { rows } = await runSystem('outbox.claim', (tx) =>
      tx.execute(sql`
        with due as (
          select id from outbox_events
           where processed_at is null and available_at <= now()
           order by available_at, id
           limit ${batchSize}
           for update skip locked
        )
        update outbox_events o
           set available_at = now() + ${leaseMs}::float8 * interval '1 millisecond', attempts = o.attempts + 1
          from due
         where o.id = due.id
        returning o.id, o.agency_id, o.type, o.version, o.payload, o.attempts, o.created_at, o.trace_parent`),
    );
    return (rows as unknown as ClaimedRow[]).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Delivery continues the emitter's trace: request → outbox → subscriber → job (S0-10). */
  function deliver(row: ClaimedRow): Promise<Outcome & { ok: boolean; dead: boolean }> {
    const attributes = {
      'messaging.system': 'outbox',
      'messaging.operation.type': 'process',
      'messaging.message.id': row.id,
      'inmolink.event.type': row.type,
      'inmolink.event.attempt': row.attempts,
    };
    return withConsumerSpan(`outbox deliver ${row.type}`, row.trace_parent, attributes, async (span) => {
      const outcome = await deliverRow(row);
      if (!outcome.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error?.slice(0, 200) });
      return outcome;
    });
  }

  async function deliverRow(row: ClaimedRow): Promise<Outcome & { ok: boolean; dead: boolean }> {
    const base = { id: row.id, attempts: row.attempts };
    const subs = subscribers.get(row.type, row.version);
    if (subs.length === 0) return { ...base, ok: true, dead: false };
    const parsed = (subs[0] as (typeof subs)[number]).def.schema.safeParse(row.payload);
    if (!parsed.success) {
      return { ...base, ok: false, dead: true, error: `invalid payload: ${errorText(parsed.error)}` };
    }
    const meta: EventMeta = {
      eventId: row.id,
      agencyId: row.agency_id,
      type: row.type,
      version: row.version,
      createdAt: new Date(row.created_at),
      attempt: row.attempts,
    };
    const errors: string[] = [];
    const all = async () => {
      for (const sub of subs) {
        try {
          await sub.handler(parsed.data, meta);
        } catch (err) {
          errors.push(`${sub.name}: ${errorText(err)}`);
        }
      }
    };
    try {
      await withTimeout(all(), deliveryTimeoutMs);
    } catch (err) {
      errors.push(errorText(err));
    }
    if (errors.length === 0) return { ...base, ok: true, dead: false };
    const error = errors.join('; ').slice(0, MAX_ERROR_LENGTH);
    if (row.attempts >= maxAttempts) return { ...base, ok: false, dead: true, error };
    return { ...base, ok: false, dead: false, error, delayMs: backoffMs(row.attempts) };
  }

  async function acknowledge(done: Outcome[], retry: Outcome[], dead: Outcome[]): Promise<void> {
    await runSystem('outbox.ack', async (tx) => {
      if (done.length > 0) {
        await tx.execute(sql`
          update outbox_events o set processed_at = now(), last_error = null
            from jsonb_to_recordset(${JSON.stringify(done.map((r) => ({ id: r.id, attempts: r.attempts })))}::jsonb)
                 as d(id uuid, attempts int)
           where o.id = d.id and o.attempts = d.attempts`);
      }
      if (retry.length > 0) {
        await tx.execute(sql`
          update outbox_events o
             set available_at = now() + d.delay_ms * interval '1 millisecond', last_error = d.error
            from jsonb_to_recordset(${JSON.stringify(retry.map((r) => ({ id: r.id, attempts: r.attempts, delay_ms: r.delayMs, error: r.error })))}::jsonb)
                 as d(id uuid, attempts int, delay_ms int, error text)
           where o.id = d.id and o.attempts = d.attempts`);
      }
      if (dead.length > 0) {
        await tx.execute(sql`
          update outbox_events o set processed_at = now(), dead_at = now(), last_error = d.error
            from jsonb_to_recordset(${JSON.stringify(dead.map((r) => ({ id: r.id, attempts: r.attempts, error: r.error })))}::jsonb)
                 as d(id uuid, attempts int, error text)
           where o.id = d.id and o.attempts = d.attempts`);
      }
    });
  }

  async function runOnce(): Promise<DispatchStats> {
    const rows = await claim();
    if (rows.length === 0) return { claimed: 0, delivered: 0, retried: 0, dead: 0 };
    const done: Outcome[] = [];
    const retry: Outcome[] = [];
    const dead: Outcome[] = [];
    await mapLimit(rows, concurrency, async (row) => {
      const outcome = await deliver(row);
      if (outcome.ok) done.push(outcome);
      else if (outcome.dead) dead.push(outcome);
      else retry.push(outcome);
    });
    await acknowledge(done, retry, dead);
    if (dead.length > 0) {
      logger.error({ count: dead.length, ids: dead.slice(0, 20).map((d) => d.id) }, 'outbox events dead-lettered');
    }
    return { claimed: rows.length, delivered: done.length, retried: retry.length, dead: dead.length };
  }

  async function prune(): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await runSystem('outbox.prune', (tx) =>
        tx.execute(sql`
          with old as (
            select id from outbox_events
             where processed_at < now() - ${Math.min(retentionMs, deadRetentionMs)}::float8 * interval '1 millisecond'
               and processed_at < now() - (case when dead_at is null then ${retentionMs}::float8 else ${deadRetentionMs}::float8 end)
                                          * interval '1 millisecond'
             limit ${PRUNE_BATCH}
          )
          delete from outbox_events o using old where o.id = old.id
          returning 1 as n`),
      );
      total += rows.length;
      if (rows.length < PRUNE_BATCH) return total;
    }
  }

  async function run(lane: number): Promise<void> {
    let lastPrune = Date.now();
    let failures = 0;
    while (running) {
      const seen = generation;
      try {
        const stats = await runOnce();
        failures = 0;
        if (lane === 0 && Date.now() - lastPrune >= pruneEveryMs) {
          lastPrune = Date.now();
          const pruned = await prune();
          if (pruned > 0) logger.info({ pruned }, 'outbox pruned');
        }
        if (stats.claimed === batchSize) continue; // backlog: go again immediately
        await sleep(pollMs, seen);
      } catch (err) {
        failures++;
        logger.warn({ err, failures, lane }, 'outbox dispatch round failed');
        await sleep(Math.min(pollMs * 2 ** failures, 30_000), generation);
      }
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      if (options.listen) {
        try {
          listener = await options.listen(signal);
        } catch (err) {
          logger.warn({ err }, 'outbox LISTEN unavailable; polling only');
        }
      }
      loops = Array.from({ length: lanes }, (_, lane) => run(lane));
    },
    async stop() {
      running = false;
      for (const wake of [...wakers]) wake();
      await Promise.all(loops);
      loops = [];
      await listener?.close();
      listener = undefined;
    },
    runOnce,
    prune,
  };
}
