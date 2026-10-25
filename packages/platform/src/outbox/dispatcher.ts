import { SpanStatusCode } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import type { Logger } from '../logger';
import { withConsumerSpan } from '../telemetry/context';
import { PLATFORM_AGENCY_ID, type SqlExecutor } from './emit';
import { defaultSubscribers, type EventMeta, isDeclaredEvent, type SubscriberRegistry } from './events';

/** `withSystem` from `@inmolink/db`, injected so platform does not depend on db. */
export type RunSystem = <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export interface DispatcherOptions {
  runSystem: RunSystem;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  subscribers?: SubscriberRegistry;
  /**
   * Whether this process knows `type@version` (default: its `defineEvent` was loaded). A known event
   * with no subscriber is done; an unknown one (newer deploy, module not wired into the worker) is
   * retried with backoff and dead-lettered after `maxAttempts`, never silently marked processed.
   */
  isKnown?: (type: string, version: number) => boolean;
  /** Rows claimed per round. */
  batchSize?: number;
  /**
   * Agencies a claim shares its batch between (per-tenant fair share). Bounds the claim's cost: each agency
   * costs an enumeration probe, a count probe and a locking scan. With more agencies due than this, a lane
   * serves the next ones on its next claim (rotating cursor), so every agency is reached within
   * ceil(due agencies / this) claims.
   */
  maxAgenciesPerClaim?: number;
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
  /** Idle poll interval (ADR 0014: no LISTEN/NOTIFY). A lane with a non-empty batch claims again at once. */
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
  /**
   * Observer of every claim round (S2-F3): the lane, when the round started (`performance.now()`) and the
   * ids it claimed. For tests and diagnostics that measure pickup on the dispatcher's own clock instead of
   * wall-clock latency; it must be cheap and must not throw (errors are ignored).
   */
  onClaim?: (round: { lane: number; startedAt: number; ids: readonly string[] }) => void;
  /**
   * S12-F19: test scope — claim only these agencies' events, and never prune (other suites' rows on the shared test
   * database stay theirs). Production dispatchers leave it unset.
   */
  agencyIds?: readonly string[];
}

const SCOPE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** One claim → deliver → acknowledge round. `lane` selects the agency cursor (default: lane 0's). */
  runOnce(lane?: number): Promise<DispatchStats>;
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
  /** Position of the row's agency in this claim's rotation (1-based); the lane resumes after the highest. */
  ord: number;
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
 *      (`FOR UPDATE SKIP LOCKED`, so several dispatchers never take the same row), shared fairly
 *      between the agencies that have due rows (see `claim`);
 *   2. deliver — subscribers run outside any transaction (they enqueue jobs over the network);
 *   3. acknowledge — one transaction marks successes processed and schedules retries / dead letters.
 * Delivery is at least once: a crash between 2 and 3 redelivers after the lease expires. A retry
 * re-runs every subscriber of the event, so each subscriber is idempotent on its own (PATTERNS §8).
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const {
    runSystem,
    logger,
    subscribers = defaultSubscribers,
    isKnown = isDeclaredEvent,
    batchSize = 500,
    maxAgenciesPerClaim = 64,
    lanes = 4,
    concurrency = 200,
    deliveryTimeoutMs = 15_000,
    leaseMs = 60_000,
    pollMs = 250,
    maxAttempts = 10,
    backoffMs = defaultBackoff,
    retentionMs = 7 * 24 * 3_600_000,
    deadRetentionMs = 30 * 24 * 3_600_000,
    pruneEveryMs = 10 * 60_000,
    onClaim,
    agencyIds,
  } = options;

  // S12-F19: the test scope, one bound array literal (ids checked first); appended to every claim predicate
  if (agencyIds && (agencyIds.length === 0 || !agencyIds.every((id) => SCOPE_UUID.test(id)))) {
    throw new RangeError('createDispatcher: agencyIds must be a non-empty list of UUIDs');
  }
  const scoped = agencyIds ? sql` and agency_id = any(${`{${agencyIds.join(',')}}`}::uuid[])` : sql``;

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
  const wakers = new Set<() => void>();
  // Per lane: the agency the last claim's rotation ended on; the next claim starts after it (wrapping).
  const cursors: string[] = [];

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (!running) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      }
      wakers.add(done);
    });

  /**
   * Per-tenant fair claim: one agency's burst must not delay another agency's events by more than one
   * batch. Instead of the oldest `batchSize` rows overall (a 50,000-row import would fill the next 100
   * batches), the claim first enumerates the agencies that have due rows — a loose index scan over
   * `outbox_events_pending_idx (agency_id, available_at, id)`, one probe per agency, at most
   * `maxAgenciesPerClaim` agencies per claim, starting after the lane's cursor and wrapping so no agency is
   * starved — then shares
   * the batch between them (water-filling: small agencies take all they have, the rest split the remainder
   * equally), takes each agency's oldest rows and interleaves them round-robin. One agency alone still gets
   * whole batches, so throughput is unchanged.
   *
   * Cost: at most `maxAgenciesPerClaim` enumeration probes; the count probes stop at the equal share
   * `ceil(batchSize / agencies)`, then at the level the small agencies leave the others, so one claim reads
   * about 2 × `batchSize` index entries for counting plus `batchSize` rows for locking — O(batchSize +
   * maxAgenciesPerClaim), never O(backlog) or O(agencies). Two caveats, both bounded: the enumeration probe walks past an agency whose
   * pending rows are all leased or in backoff (O(that agency's pending rows) once per claim), and the counts
   * include rows another lane holds locked, which the lateral pick then skips — the batch comes out
   * under-full, never unfair, and the lane claims again at once.
   */
  async function claim(lane: number): Promise<ClaimedRow[]> {
    const cursor = cursors[lane] ?? PLATFORM_AGENCY_ID;
    const { rows } = await runSystem('outbox.claim', (tx) =>
      tx.execute(sql`
        with recursive after_cursor(agency_id, n) as (
          select (select agency_id from outbox_events
                   where processed_at is null and available_at <= now()${scoped} and agency_id > ${cursor}::uuid
                   order by agency_id limit 1), 1
          union all
          select (select agency_id from outbox_events
                   where processed_at is null and available_at <= now()${scoped} and agency_id > a.agency_id
                   order by agency_id limit 1), a.n + 1
            from after_cursor a
           where a.agency_id is not null and a.n < ${maxAgenciesPerClaim}::int
        ),
        found_after as (select agency_id, n from after_cursor where agency_id is not null),
        up_to_cursor(agency_id, n) as (
          select (select agency_id from outbox_events
                   where processed_at is null and available_at <= now()${scoped} and agency_id <= ${cursor}::uuid
                   order by agency_id limit 1), 1
           where (select count(*) from found_after) < ${maxAgenciesPerClaim}::int
          union all
          select (select agency_id from outbox_events
                   where processed_at is null and available_at <= now()${scoped}
                     and agency_id > a.agency_id and agency_id <= ${cursor}::uuid
                   order by agency_id limit 1), a.n + 1
            from up_to_cursor a
           where a.agency_id is not null and a.n + (select count(*) from found_after) < ${maxAgenciesPerClaim}::int
        ),
        agencies as (
          select agency_id, n as ord from found_after
          union all
          select agency_id, n + (select count(*) from found_after) from up_to_cursor where agency_id is not null
        ),
        -- Due rows per agency, counted only as far as the water-filling needs: first up to the equal share
        -- (an agency at the share has "at least its share"), then the agencies at the share are recounted up
        -- to the level the smaller ones leave them. Both passes together read about 2 × batchSize index entries
        -- whatever the backlog. Materialized so each probe runs once.
        share as (select ceil(${batchSize}::float8 / greatest(count(*), 1))::int as rows from agencies),
        first_count as materialized (
          select a.agency_id, a.ord, s.rows as share,
                 (select count(*) from (
                    select 1 from outbox_events e
                     where e.processed_at is null and e.available_at <= now()${scoped} and e.agency_id = a.agency_id
                     limit s.rows) c) as due_count
            from agencies a, share s
        ),
        refine as (
          select greatest(share, ceil((${batchSize}::int - coalesce(sum(due_count) filter (where due_count < share), 0))::float8
                                      / greatest(count(*) filter (where due_count >= share), 1))::int) as probe
            from first_count group by share
        ),
        counted as materialized (
          select f.agency_id, f.ord, r.probe,
                 case when f.due_count >= f.share and r.probe > f.share
                      then (select count(*) from (
                             select 1 from outbox_events e
                              where e.processed_at is null and e.available_at <= now()${scoped} and e.agency_id = f.agency_id
                              limit r.probe) c)
                      else f.due_count end as due_count
            from first_count f, refine r
        ),
        ranked as (
          select agency_id, ord, probe, due_count,
                 coalesce(sum(due_count) over (order by due_count, ord rows between unbounded preceding and 1 preceding), 0) as smaller,
                 count(*) over () - row_number() over (order by due_count, ord) + 1 as remaining
            from counted
        ),
        -- Water-filling: agencies sorted by due rows; the smaller ones take everything they have, the rest
        -- split what is left equally. The level is set by the first agency that reaches it (or the probe limit).
        level as (
          select (select ceil((${batchSize}::int - smaller)::float8 / remaining)::int from ranked
                   where due_count >= probe or due_count * remaining + smaller >= ${batchSize}::int
                   order by due_count, ord limit 1) as cap
        ),
        quota as (
          select r.agency_id, r.ord,
                 case when l.cap is null then r.due_count            -- fewer due rows than the batch: take all
                      when r.due_count >= r.probe then l.cap         -- big: its count was capped, so trust the level
                      else least(r.due_count, l.cap) end as quota_rows
            from ranked r, level l
        ),
        due as (
          select p.id, p.available_at, q.ord, row_number() over (partition by q.ord order by p.available_at, p.id) as rn
            from quota q
           cross join lateral (
             select e.id, e.available_at from outbox_events e
              where e.processed_at is null and e.available_at <= now()${scoped} and e.agency_id = q.agency_id
              order by e.available_at, e.id
              limit q.quota_rows
              for update skip locked) p
        ),
        -- Round-robin cut: one row per agency in rotation order, then the second row of each, …; so with more
        -- agencies than rows the lane's cursor moves on to the agencies that were left out.
        picked as (select id, ord from due order by rn, ord limit ${batchSize}::int)
        update outbox_events o
           set available_at = now() + ${leaseMs}::float8 * interval '1 millisecond', attempts = o.attempts + 1
          from picked
         where o.id = picked.id
        returning o.id, o.agency_id, o.type, o.version, o.payload, o.attempts, o.created_at, o.trace_parent, picked.ord`),
    );
    const claimed = rows as unknown as ClaimedRow[];
    let last: ClaimedRow | undefined;
    for (const row of claimed) if (!last || row.ord > last.ord) last = row;
    cursors[lane] = last ? last.agency_id : PLATFORM_AGENCY_ID;
    return claimed.sort((a, b) => (a.id < b.id ? -1 : 1));
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
    if (subs.length === 0) {
      if (isKnown(row.type, row.version)) return { ...base, ok: true, dead: false };
      return failed(row, `${row.type}@${row.version} is not defined in this process`);
    }
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
    return failed(row, errors.join('; '));
  }

  function failed(row: ClaimedRow, message: string): Outcome & { ok: boolean; dead: boolean } {
    const base = { id: row.id, attempts: row.attempts, error: message.slice(0, MAX_ERROR_LENGTH) };
    if (row.attempts >= maxAttempts) return { ...base, ok: false, dead: true };
    return { ...base, ok: false, dead: false, delayMs: backoffMs(row.attempts) };
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

  async function runOnce(lane = 0): Promise<DispatchStats> {
    const startedAt = performance.now();
    const rows = await claim(lane);
    if (onClaim) {
      try {
        onClaim({ lane, startedAt, ids: rows.map((r) => r.id) });
      } catch {
        // an observer never breaks dispatch
      }
    }
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
    if (agencyIds) return 0; // S12-F19: a test-scoped dispatcher leaves the shared table alone
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
          delete from outbox_events where id = any(array(select id from old))
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
      try {
        const stats = await runOnce(lane);
        failures = 0;
        if (lane === 0 && Date.now() - lastPrune >= pruneEveryMs) {
          lastPrune = Date.now();
          const pruned = await prune();
          if (pruned > 0) logger.info({ pruned }, 'outbox pruned');
        }
        // Work was found: drain without a pause (a fair batch can be under-full while rows are due).
        if (stats.claimed > 0) continue;
        await sleep(pollMs);
      } catch (err) {
        failures++;
        logger.warn({ err, failures, lane }, 'outbox dispatch round failed');
        await sleep(Math.min(pollMs * 2 ** failures, 30_000));
      }
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      loops = Array.from({ length: lanes }, (_, lane) => run(lane));
    },
    async stop() {
      running = false;
      for (const wake of [...wakers]) wake();
      await Promise.all(loops);
      loops = [];
    },
    runOnce,
    prune,
  };
}
