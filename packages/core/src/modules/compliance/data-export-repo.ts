import type { Tx } from '@inmolink/db';
import { dataExportJobs } from '@inmolink/db/schema/compliance';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../pagination';

/** `data_export_jobs` queries (S10-08). Takes `tx`; only the columns the callers need. */

const exportColumns = {
  id: dataExportJobs.id,
  agencyId: dataExportJobs.agencyId,
  createdBy: dataExportJobs.createdBy,
  kind: dataExportJobs.kind,
  format: dataExportJobs.format,
  status: dataExportJobs.status,
  counts: dataExportJobs.counts,
  fileBytes: dataExportJobs.fileBytes,
  errorCode: dataExportJobs.errorCode,
  attempts: dataExportJobs.attempts,
  startedAt: dataExportJobs.startedAt,
  finishedAt: dataExportJobs.finishedAt,
  expiresAt: dataExportJobs.expiresAt,
  createdAt: dataExportJobs.createdAt,
};

export type ExportRow = {
  id: string;
  agencyId: string;
  createdBy: string;
  kind: string;
  format: string;
  status: string;
  counts: Record<string, number>;
  fileBytes: number | null;
  errorCode: string | null;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
};

/**
 * Inserts a queued export. `null` when a unique index refused it — the agency already has one queued or running
 * (`data_export_jobs_active_uq`), or a concurrent request took the same `Idempotency-Key`: `on conflict do nothing`
 * keeps the transaction usable for the caller's follow-up read.
 */
export async function insertExport(
  tx: Tx,
  row: {
    id: string;
    agencyId: string;
    createdBy: string;
    kind: string;
    format: string;
    idempotencyHash: string | null;
    requestHash: string | null;
  },
): Promise<ExportRow | null> {
  const [inserted] = await tx.insert(dataExportJobs).values(row).onConflictDoNothing().returning(exportColumns);
  return inserted ?? null;
}

/** The export a member's `Idempotency-Key` created within the replay window, with its body's hash. */
export async function exportByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ id: string; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ id: dataExportJobs.id, requestHash: dataExportJobs.requestHash })
    .from(dataExportJobs)
    .where(
      and(
        eq(dataExportJobs.agencyId, agencyId),
        eq(dataExportJobs.idempotencyHash, hash),
        gt(dataExportJobs.createdAt, since),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getExport(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<ExportRow | null> {
  const q = tx.select(exportColumns).from(dataExportJobs).where(eq(dataExportJobs.id, id)).limit(1);
  const [row] = await (opts.forUpdate ? q.for('update') : q);
  return row ?? null;
}

/** The agency's exports, newest first (keyset). */
export async function listExports(
  tx: Tx,
  agencyId: string,
  page: { limit: number; cursor?: KeysetCursor | undefined },
): Promise<ExportRow[]> {
  return tx
    .select(exportColumns)
    .from(dataExportJobs)
    .where(
      and(
        eq(dataExportJobs.agencyId, agencyId),
        keysetAfter(dataExportJobs.createdAt, dataExportJobs.id, page.cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(dataExportJobs.createdAt, dataExportJobs.id, 'desc'))
    .limit(page.limit + 1);
}

/**
 * Records a run's outcome — only while the run still holds the export: `RUNNING` with the claim's attempt number. A
 * stale attempt (a later claim took over, or the sweep failed the export) changes nothing and gets `false`.
 */
export async function finishExport(
  tx: Tx,
  id: string,
  attempt: number,
  patch: Pick<
    typeof dataExportJobs.$inferInsert,
    'status' | 'counts' | 'fileBytes' | 'errorCode' | 'finishedAt' | 'expiresAt'
  >,
): Promise<boolean> {
  const rows = await tx
    .update(dataExportJobs)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(dataExportJobs.id, id), eq(dataExportJobs.status, 'RUNNING'), eq(dataExportJobs.attempts, attempt)))
    .returning({ id: dataExportJobs.id });
  return rows.length > 0;
}

/** Claims a queued (or crashed running) export for a run: `RUNNING`, one more attempt. */
export async function claimExport(tx: Tx, id: string): Promise<ExportRow | null> {
  const [row] = await tx
    .update(dataExportJobs)
    .set({
      status: 'RUNNING',
      attempts: sql`${dataExportJobs.attempts} + 1`,
      startedAt: sql`coalesce(${dataExportJobs.startedAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(dataExportJobs.id, id), inArray(dataExportJobs.status, ['QUEUED', 'RUNNING'])))
    .returning(exportColumns);
  return row ?? null;
}

/** Finished exports past their expiry whose file may still be in storage (every agency: the sweep, `withSystem`). */
export async function expiredFiles(tx: Tx, now: Date, limit: number): Promise<{ id: string; agencyId: string }[]> {
  return tx
    .select({ id: dataExportJobs.id, agencyId: dataExportJobs.agencyId })
    .from(dataExportJobs)
    .where(
      and(isNull(dataExportJobs.fileDeletedAt), isNotNull(dataExportJobs.expiresAt), lt(dataExportJobs.expiresAt, now)),
    )
    .orderBy(asc(dataExportJobs.expiresAt))
    .limit(limit);
}

export async function markExpired(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(dataExportJobs)
    .set({
      status: sql`case when ${dataExportJobs.status} = 'SUCCEEDED' then 'EXPIRED' else ${dataExportJobs.status} end`,
      fileDeletedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(inArray(dataExportJobs.id, [...ids]));
}

/**
 * Exports queued or running since before `before` (a lost job): failed, so the agency can start another; expiring
 * now, so the sweep deletes whatever a crashed run may have stored.
 */
export async function failStuck(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .update(dataExportJobs)
    .set({
      status: 'FAILED',
      errorCode: 'TIMEOUT',
      finishedAt: sql`now()`,
      expiresAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(inArray(dataExportJobs.status, ['QUEUED', 'RUNNING']), lt(dataExportJobs.createdAt, before)))
    .returning({ id: dataExportJobs.id });
  return rows.length;
}
