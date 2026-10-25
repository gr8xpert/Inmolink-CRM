import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { countReplayable, type ReplayFilter, replayOutboxBatch } from '@inmolink/platform/outbox';
import { defineJob, queueHealth } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as imports from '../imports';
import * as search from '../search';
import { adminConfig } from './config';
import { replayClass } from './replay-policy';
import * as repo from './repo';

/**
 * admin worker jobs (PATTERNS §12), pool `maintenance`:
 *
 * `admin.runStaffOperation` (one per `admin.operation.requested` event, job ID = the operation's id; each continuation
 * `<id>:<slice>`, the slice counted on the row so no ID repeats) runs a staff bulk operation one bounded step at a time,
 * `withSystem` (the reason names the operation). Before every step it re-reads the operation: a cancel request ends it
 * CANCELLED there. Every step records its cursor and progress (`done` of `total`) in one statement, so a retried,
 * continued or recovered job resumes after the last recorded step, and `done` always matches the cursor. Each step is
 * idempotent — queueing a rebuild, an index push or a feed run twice is harmless (upserts, the per-connection run mutex),
 * outbox consumers are idempotent — so a step repeated after a crash costs only time. A job runs for at most
 * `sliceMs`, then queues its continuation (one long operation never holds a slot).
 *
 * Steps (one agency at a time, the cursor carrying the position inside it):
 * - `REINDEX` / `REBUILD_READ_MODELS`: one page (≤ `targetPage` targets of one kind) of the agency's index pushes /
 *   read-model rebuilds (`search.queueAgencyTargetsPage`), then the throttled sync / build request. While the indexing
 *   pool has more than `poolBacklogLimit` jobs waiting, the step waits (`backoffMs`, a delayed continuation).
 * - `REIMPORT`: a run of each enabled, unpaused feed of one agency (`imports.queueAgencyReimport`, ≤ 200), the same
 *   wait on the imports pool.
 * - `REPLAY_OUTBOX`: `replayBatch` events (`replayOutboxBatch`), then `replayPaceMs` before the next — the dispatcher
 *   drains each batch first. The first step counts the window up to `replayMaxEvents` (a capped count) and refuses a
 *   bigger one (FAILED `REPLAY_TOO_LARGE`); a type the replay policy refuses fails too (the service refused it first).
 *
 * `admin.sweepStaffOperations` (every 5 minutes): active operations that recorded nothing for `OPERATION_STALE_MS`
 * (their job was lost: a crash, a flushed queue) get a new job — at most `MAX_RECOVERIES` times, then they end FAILED
 * (`STALLED`). One asked to stop ends CANCELLED.
 */

const ATTEMPTS = 3;
/** An active operation that recorded nothing for this long is taken as stopped (the sweep, the cancel). */
export const OPERATION_STALE_MS = 15 * 60_000;
/** Times the sweep re-queues a stalled operation before it ends FAILED (`STALLED`). */
export const MAX_RECOVERIES = 3;
const SWEEP_BATCH = 100;

type Kind = 'LISTING' | 'UNIT';
interface AgencyCursor {
  /** The last agency finished. */
  last: string | null;
  /** The agency in progress and the position inside it (reindex / rebuild). */
  cur: { agencyId: string; kind: Kind; after: string | null } | null;
}
interface ReplayCursor {
  after: string | null;
}
type Step = { cursor: string; doneDelta: number; finished: boolean };

const reason = (id: string) => `admin.runStaffOperation ${id}`;

function agencyCursor(op: repo.OperationRow): AgencyCursor {
  return op.cursor ? (JSON.parse(op.cursor) as AgencyCursor) : { last: null, cur: null };
}

function replayFilter(op: repo.OperationRow): ReplayFilter {
  const r = op.params.replay;
  if (!r) throw new TypeError(`staff operation ${op.id}: REPLAY_OUTBOX without a window`);
  return {
    since: new Date(r.since),
    until: new Date(r.until),
    type: r.type,
    ...(op.targetAgencyId ? { agencyId: op.targetAgencyId } : {}),
    deadOnly: r.deadOnly,
  };
}

/** The pool an agency step feeds, if it is too busy for another step now. */
async function poolBusy(op: repo.OperationRow): Promise<boolean> {
  if (op.kind === 'REPLAY_OUTBOX') return false;
  const pool = op.kind === 'REIMPORT' ? 'imports' : 'indexing';
  const [health] = await queueHealth([pool]);
  return (health?.waiting ?? 0) > adminConfig().poolBacklogLimit;
}

/** The next agency to work on after `last` (the target agency once; every agency in id order otherwise). */
async function nextAgency(op: repo.OperationRow, last: string | null): Promise<string | null> {
  if (op.targetAgencyId) return last ? null : op.targetAgencyId;
  const [id] = await withSystem(reason(op.id), (tx) => agencies.agencyIdsPage(tx, last, 1));
  return id ?? null;
}

/** One bounded step (outside any transaction: the steps open their own, and queue jobs). */
async function runStep(op: repo.OperationRow): Promise<Step> {
  const config = adminConfig();
  if (op.kind === 'REPLAY_OUTBOX') {
    const from = op.cursor ? (JSON.parse(op.cursor) as ReplayCursor).after : null;
    const batch = await withSystem(reason(op.id), (tx) =>
      replayOutboxBatch(tx, replayFilter(op), { afterId: from ?? undefined, limit: config.replayBatch }),
    );
    const cursor: ReplayCursor = { after: batch.lastId ?? from };
    return { cursor: JSON.stringify(cursor), doneDelta: batch.replayed, finished: batch.replayed < config.replayBatch };
  }

  const c = agencyCursor(op);
  let cur = c.cur;
  if (!cur) {
    const agencyId = await nextAgency(op, c.last);
    if (!agencyId) return { cursor: JSON.stringify(c), doneDelta: 0, finished: true };
    if (op.kind === 'REIMPORT') {
      await withSystem(reason(op.id), (tx) => imports.queueAgencyReimport(tx, agencyId));
      const next: AgencyCursor = { last: agencyId, cur: null };
      return { cursor: JSON.stringify(next), doneDelta: 1, finished: op.targetAgencyId !== null };
    }
    cur = { agencyId, kind: 'LISTING', after: null };
  }
  const what = op.kind === 'REINDEX' ? 'index' : 'readModel';
  const page = await search.queueAgencyTargetsPage(
    what,
    { agencyId: cur.agencyId, kind: cur.kind, after: cur.after, limit: config.targetPage },
    search.READ_MODEL_DEBOUNCE_MS,
  );
  if (page.queued > 0) {
    if (what === 'index') await search.requestIndexSync();
    else await search.requestReadModelBuild(cur.agencyId);
  }
  let next: AgencyCursor;
  let doneDelta = 0;
  if (page.last !== null) next = { last: c.last, cur: { ...cur, after: page.last } };
  else if (cur.kind === 'LISTING') next = { last: c.last, cur: { agencyId: cur.agencyId, kind: 'UNIT', after: null } };
  else {
    next = { last: cur.agencyId, cur: null };
    doneDelta = 1;
  }
  return {
    cursor: JSON.stringify(next),
    doneDelta,
    finished: doneDelta === 1 && op.targetAgencyId !== null,
  };
}

/** The operation's total (agencies, or matching events up to the cap + 1), counted at its first step. */
async function countTotal(op: repo.OperationRow): Promise<number> {
  if (op.kind === 'REPLAY_OUTBOX') {
    return withSystem(reason(op.id), (tx) =>
      countReplayable(tx, replayFilter(op), { cap: adminConfig().replayMaxEvents }),
    );
  }
  if (op.targetAgencyId) return 1;
  return withSystem(reason(op.id), (tx) => agencies.countAgencies(tx));
}

/** Audits an operation's end (actor: system), in the transaction that ended it. */
async function auditEnd(tx: Tx, op: repo.OperationRow, state: repo.OperationState, errorCode?: string) {
  const after = await repo.getOperation(tx, op.id);
  await compliance.auditSystem(tx, {
    type: 'staff.operation.finished',
    agencyId: op.targetAgencyId,
    target: { type: 'staffOperation', id: op.id },
    metadata: {
      kind: op.kind,
      state,
      done: after?.done ?? op.done,
      total: after?.total ?? op.total,
      ...(errorCode ? { errorCode } : {}),
    },
  });
}

type End = { state: 'SUCCEEDED'; step: Step } | { state: 'CANCELLED' } | { state: 'FAILED'; errorCode: string };

/**
 * Ends the operation (records its last step, or ends it CANCELLED / FAILED) and audits the end, one transaction.
 * Answers the state it is in afterwards: when something else ended it first (a cancel racing the last step), that one.
 */
async function finish(op: repo.OperationRow, end: End): Promise<{ state: repo.OperationState; done: number }> {
  return withSystem(reason(op.id), async (tx) => {
    const now = clock.now();
    const ended =
      end.state === 'SUCCEEDED'
        ? await repo.recordStep(tx, op.id, { ...end.step, finished: true }, now)
        : await repo.endOperation(tx, op.id, end.state, now, end.state === 'FAILED' ? end.errorCode : null);
    if (ended) await auditEnd(tx, op, end.state, end.state === 'FAILED' ? end.errorCode : undefined);
    const after = await repo.getOperation(tx, op.id);
    return { state: after?.state ?? end.state, done: after?.done ?? op.done };
  });
}

export interface OperationRunResult {
  state: repo.OperationState | 'GONE';
  done: number;
  /** Whether more is left for a continuation job (the time box ran out, or a busy pool asked to wait). */
  more: boolean;
  /** How long the continuation should wait (a busy pool). */
  delayMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Runs the operation until it ends, is cancelled, a busy pool asks to wait, or `budgetMs` runs out (exported for
 * tests: the job calls it with the configured slice). `onProgress` reports `{ done, total }` after each step.
 */
export async function runStaffOperation(
  operationId: string,
  options: {
    budgetMs?: number;
    /** Stop (with `more`) after this many steps — tests, and a careful first slice. */
    maxSteps?: number;
    signal?: AbortSignal;
    onProgress?: (p: { done: number; total: number | null }) => unknown;
  } = {},
): Promise<OperationRunResult> {
  const config = adminConfig();
  const deadline = Date.now() + (options.budgetMs ?? config.sliceMs);
  let steps = 0;
  for (;;) {
    if (options.signal?.aborted) throw new Error('admin.runStaffOperation: aborted');
    const op = await withSystem(reason(operationId), (tx) => repo.getOperation(tx, operationId));
    if (!op) return { state: 'GONE', done: 0, more: false };
    if (op.state !== 'QUEUED' && op.state !== 'RUNNING') return { state: op.state, done: op.done, more: false };
    if (op.cancelRequestedAt) return { ...(await finish(op, { state: 'CANCELLED' })), more: false };
    if (op.state === 'QUEUED') {
      if (op.kind === 'REPLAY_OUTBOX' && replayClass(op.params.replay?.type ?? '') === 'REFUSED') {
        return { ...(await finish(op, { state: 'FAILED', errorCode: 'REPLAY_TYPE_REFUSED' })), more: false };
      }
      const total = await countTotal(op);
      if (op.kind === 'REPLAY_OUTBOX' && total > config.replayMaxEvents) {
        return { ...(await finish(op, { state: 'FAILED', errorCode: 'REPLAY_TOO_LARGE' })), more: false };
      }
      await withSystem(reason(op.id), (tx) => repo.markRunning(tx, op.id, total, clock.now()));
      continue;
    }
    if (Date.now() >= deadline || steps >= (options.maxSteps ?? Number.POSITIVE_INFINITY)) {
      return { state: 'RUNNING', done: op.done, more: true };
    }
    if (await poolBusy(op)) return { state: 'RUNNING', done: op.done, more: true, delayMs: config.backoffMs };
    if (steps > 0 && op.kind === 'REPLAY_OUTBOX') await sleep(config.replayPaceMs, options.signal);
    const step = await runStep(op);
    steps++;
    const done = op.done + step.doneDelta;
    if (step.finished) {
      const end = await finish(op, { state: 'SUCCEEDED', step });
      await options.onProgress?.({ done: end.done, total: op.total });
      return { ...end, more: false };
    }
    const recorded = await withSystem(reason(op.id), (tx) => repo.recordStep(tx, op.id, step, clock.now()));
    if (recorded) await options.onProgress?.({ done, total: op.total });
  }
}

/** Queues the operation's next job (a new slice: its own job ID), optionally delayed. */
async function continueLater(operationId: string, delayMs?: number): Promise<void> {
  const slice = await withSystem(reason(operationId), (tx) => repo.nextSlice(tx, operationId, clock.now()));
  await adminJobs.runStaffOperation.enqueue({ operationId, slice }, delayMs ? { delayMs } : {});
}

export const adminJobs = {
  runStaffOperation: defineJob({
    name: 'admin.runStaffOperation',
    pool: 'maintenance',
    payload: z.object({ operationId: z.uuid(), slice: z.number().int().min(1).optional() }),
    jobId: (p) => (p.slice ? `${p.operationId}:${p.slice}` : p.operationId),
    group: () => 'staff-operations',
    concurrencyPerGroup: 2,
    attempts: ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 15 * 60_000,
    async run(p, job) {
      try {
        const result = await runStaffOperation(p.operationId, {
          signal: job.signal,
          onProgress: (progress) => job.progress(progress),
        });
        if (result.more) await continueLater(p.operationId, result.delayMs);
        job.log.info({ operationId: p.operationId, ...result }, 'staff operation slice done');
        return result;
      } catch (err) {
        if (job.attempt >= ATTEMPTS) {
          const op = await withSystem(reason(p.operationId), (tx) => repo.getOperation(tx, p.operationId));
          if (op) await finish(op, { state: 'FAILED', errorCode: 'INTERNAL' });
        }
        throw err;
      }
    },
  }),

  sweepStaffOperations: defineJob({
    name: 'admin.sweepStaffOperations',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 5 * 60_000,
    attempts: 3,
    async run(_p, { log }) {
      const now = clock.now();
      const requeue = await withSystem('admin.sweepStaffOperations', async (tx) => {
        const stalled = await repo.claimStalled(tx, new Date(now.getTime() - OPERATION_STALE_MS), SWEEP_BATCH);
        const out: { operationId: string; slice: number }[] = [];
        for (const op of stalled) {
          if (op.cancelRequestedAt || op.recoveries >= MAX_RECOVERIES) {
            const state = op.cancelRequestedAt ? 'CANCELLED' : 'FAILED';
            await repo.endOperation(tx, op.id, state, now, state === 'FAILED' ? 'STALLED' : null);
            await auditEnd(tx, op, state, state === 'FAILED' ? 'STALLED' : undefined);
          } else {
            out.push({ operationId: op.id, slice: await repo.markRecovered(tx, op.id, now) });
          }
        }
        return { out, ended: stalled.length - out.length };
      });
      for (const p of requeue.out) await adminJobs.runStaffOperation.enqueue(p);
      if (requeue.out.length + requeue.ended > 0)
        log.warn({ ...requeue, out: requeue.out.length }, 'stalled staff operations');
      return { requeued: requeue.out.length, ended: requeue.ended };
    },
  }),
};
