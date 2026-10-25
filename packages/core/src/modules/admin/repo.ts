/**
 * admin queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/admin` — other modules' tables fail `pnpm check:boundaries`.
 */
import type { Tx } from '@inmolink/db';
import { staffOperations } from '@inmolink/db/schema/admin';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter, rowOrder } from '../../pagination';

export type OperationKind = 'REINDEX' | 'REBUILD_READ_MODELS' | 'REIMPORT' | 'REPLAY_OUTBOX';
export type OperationState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface ReplayParams {
  since: string;
  until: string;
  type: string;
  deadOnly: boolean;
}

const columns = {
  id: staffOperations.id,
  kind: staffOperations.kind,
  targetAgencyId: staffOperations.targetAgencyId,
  params: staffOperations.params,
  state: staffOperations.state,
  cursor: staffOperations.cursor,
  done: staffOperations.done,
  total: staffOperations.total,
  slices: staffOperations.slices,
  recoveries: staffOperations.recoveries,
  reason: staffOperations.reason,
  requestedBy: staffOperations.requestedBy,
  cancelRequestedAt: staffOperations.cancelRequestedAt,
  errorCode: staffOperations.errorCode,
  createdAt: staffOperations.createdAt,
  startedAt: staffOperations.startedAt,
  finishedAt: staffOperations.finishedAt,
  updatedAt: staffOperations.updatedAt,
};

export interface OperationRow {
  id: string;
  kind: OperationKind;
  targetAgencyId: string | null;
  params: { replay?: ReplayParams };
  state: OperationState;
  cursor: string | null;
  done: number;
  total: number | null;
  slices: number;
  recoveries: number;
  reason: string;
  requestedBy: string;
  cancelRequestedAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

const asRow = (r: unknown) => r as OperationRow;

/** Inserts a QUEUED operation; null when one of the same kind and scope is already active (`staff_operations_active_uq`). */
export async function insertOperation(
  tx: Tx,
  row: {
    id: string;
    kind: OperationKind;
    targetAgencyId: string | null;
    params: { replay?: ReplayParams };
    reason: string;
    requestedBy: string;
    createdAt: Date;
  },
): Promise<OperationRow | null> {
  const [created] = await tx.insert(staffOperations).values(row).onConflictDoNothing().returning(columns);
  return created ? asRow(created) : null;
}

export async function getOperation(tx: Tx, id: string, options: { lock?: boolean } = {}): Promise<OperationRow | null> {
  const q = tx.select(columns).from(staffOperations).where(eq(staffOperations.id, id));
  const [row] = options.lock ? await q.for('update') : await q;
  return row ? asRow(row) : null;
}

/** The console's list: newest first (`staff_operations_created_idx`), keyset, optionally one state. */
export async function listOperations(
  tx: Tx,
  q: { limit: number; cursor?: KeysetCursor; state?: OperationState },
): Promise<OperationRow[]> {
  const rows = await tx
    .select(columns)
    .from(staffOperations)
    .where(
      and(
        q.state ? eq(staffOperations.state, q.state) : undefined,
        rowAfter(staffOperations.createdAt, staffOperations.id, q.cursor),
      ),
    )
    .orderBy(...rowOrder(staffOperations.createdAt, staffOperations.id))
    .limit(q.limit + 1);
  return rows.map(asRow);
}

/**
 * Staff cancel (the row is locked by the caller): a queued operation — or a running one whose job stopped moving
 * (`updated_at` before `staleBefore`: its worker is gone) — ends CANCELLED now; a running one is asked to stop and its
 * job ends it before its next step. Answers the row after the change.
 */
export async function requestCancel(
  tx: Tx,
  id: string,
  by: string,
  now: Date,
  staleBefore: Date,
): Promise<OperationRow> {
  const [row] = await tx
    .update(staffOperations)
    .set({
      cancelRequestedAt: sql`coalesce(${staffOperations.cancelRequestedAt}, ${now.toISOString()}::timestamptz)`,
      cancelledBy: by,
      state: sql`case when ${staffOperations.state} = 'QUEUED' or ${staffOperations.updatedAt} < ${staleBefore.toISOString()}::timestamptz then 'CANCELLED' else ${staffOperations.state} end`,
      finishedAt: sql`case when ${staffOperations.state} = 'QUEUED' or ${staffOperations.updatedAt} < ${staleBefore.toISOString()}::timestamptz then ${now.toISOString()}::timestamptz else null end`,
      updatedAt: now,
    })
    .where(and(eq(staffOperations.id, id), inArray(staffOperations.state, ['QUEUED', 'RUNNING'])))
    .returning(columns);
  return asRow(row);
}

/** Marks the operation RUNNING with its total (the first step). */
export async function markRunning(tx: Tx, id: string, total: number, now: Date): Promise<void> {
  await tx
    .update(staffOperations)
    .set({ state: 'RUNNING', total, startedAt: now, updatedAt: now })
    .where(and(eq(staffOperations.id, id), eq(staffOperations.state, 'QUEUED')));
}

/** Records a step: the new cursor, `doneDelta` more done; `finished` ends it SUCCEEDED. Only while RUNNING. */
export async function recordStep(
  tx: Tx,
  id: string,
  step: { cursor: string | null; doneDelta: number; finished: boolean },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(staffOperations)
    .set({
      cursor: step.cursor,
      done: sql`${staffOperations.done} + ${step.doneDelta}`,
      updatedAt: now,
      ...(step.finished ? { state: 'SUCCEEDED', finishedAt: now } : {}),
    })
    .where(and(eq(staffOperations.id, id), eq(staffOperations.state, 'RUNNING')))
    .returning({ id: staffOperations.id });
  return rows.length > 0;
}

/** Ends a queued or running operation as `state` (CANCELLED at the job's next step, FAILED after its last attempt). */
export async function endOperation(
  tx: Tx,
  id: string,
  state: 'CANCELLED' | 'FAILED',
  now: Date,
  errorCode: string | null = null,
): Promise<boolean> {
  const rows = await tx
    .update(staffOperations)
    .set({ state, finishedAt: now, updatedAt: now, errorCode })
    .where(and(eq(staffOperations.id, id), inArray(staffOperations.state, ['QUEUED', 'RUNNING'])))
    .returning({ id: staffOperations.id });
  return rows.length > 0;
}

/** Takes the next continuation number (its job ID `<id>:<slice>` is new) and marks the operation as moving. */
export async function nextSlice(tx: Tx, id: string, now: Date): Promise<number> {
  const [row] = await tx
    .update(staffOperations)
    .set({ slices: sql`${staffOperations.slices} + 1`, updatedAt: now })
    .where(eq(staffOperations.id, id))
    .returning({ slices: staffOperations.slices });
  return row?.slices ?? 0;
}

/**
 * Active operations whose job stopped moving (`updated_at` before `before`), locked for the sweep (`skip locked`: a
 * concurrent sweep takes others), at most `limit` (`staff_operations_active_idx`).
 */
export async function claimStalled(tx: Tx, before: Date, limit: number): Promise<OperationRow[]> {
  const rows = await tx
    .select(columns)
    .from(staffOperations)
    .where(and(inArray(staffOperations.state, ['QUEUED', 'RUNNING']), lt(staffOperations.updatedAt, before)))
    .orderBy(staffOperations.updatedAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  return rows.map(asRow);
}

/** The sweep re-queues a stalled operation: one more recovery and slice (the new job's ID); answers the slice. */
export async function markRecovered(tx: Tx, id: string, now: Date): Promise<number> {
  const [row] = await tx
    .update(staffOperations)
    .set({
      recoveries: sql`${staffOperations.recoveries} + 1`,
      slices: sql`${staffOperations.slices} + 1`,
      updatedAt: now,
    })
    .where(eq(staffOperations.id, id))
    .returning({ slices: staffOperations.slices });
  return row?.slices ?? 0;
}
