/**
 * Validation report queries (S14-03, PLAN §14 step 6). Queries only `@inmolink/db/schema/migration`: the load's
 * checkpoints (read by the validation script, `withSystem()`) and the reports (written by the script, read by staff
 * through `app_staff`, registry `staffRead`).
 */
import type { MigrationValidationReport, MigrationValidationStatus } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { migrationBatches, migrationValidationReports } from '@inmolink/db/schema/migration';
import { and, eq, notLike, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter, rowOrder } from '../../pagination';

/** The delta's checkpoint keys (`DELTA.CHECKPOINT_PREFIX`; `delta:state` too). */
const DELTA_CHECKPOINT_PREFIX = 'delta:';

export interface AgencyCheckpoint {
  entity: string;
  seq: number;
  status: 'DONE' | 'FAILED';
  counts: Record<string, Record<string, number>>;
  issues: unknown[];
  error: string | null;
}

/**
 * Every full-load checkpoint of a legacy agency (all entities). The hourly delta's (`delta:<entity>`, `delta:state`)
 * are not the load's: an old failed delta batch is re-run by the next delta and must not fail the report (S14 review).
 * One statement (`migration_batches_batch_uq`).
 */
export async function agencyCheckpoints(tx: Tx, legacyAgencyId: string): Promise<AgencyCheckpoint[]> {
  return (await tx
    .select({
      entity: migrationBatches.entity,
      seq: migrationBatches.seq,
      status: migrationBatches.status,
      counts: migrationBatches.counts,
      issues: migrationBatches.issues,
      error: migrationBatches.error,
    })
    .from(migrationBatches)
    .where(
      and(
        eq(migrationBatches.legacyAgencyId, legacyAgencyId),
        notLike(migrationBatches.entity, `${DELTA_CHECKPOINT_PREFIX}%`),
      ),
    )
    .orderBy(migrationBatches.entity, migrationBatches.seq)) as AgencyCheckpoint[];
}

export interface ReportInsert {
  id: string;
  legacyAgencyId: string;
  targetAgencyId: string;
  status: MigrationValidationStatus;
  legacyRows: number;
  unexplained: number;
  sampleDiffs: number;
  urlFailures: number;
  report: MigrationValidationReport;
  createdAt: Date;
}

/** Records a report as the legacy agency's latest (the previous latest becomes history). Two statements. */
export async function insertReport(tx: Tx, row: ReportInsert): Promise<void> {
  await tx
    .update(migrationValidationReports)
    .set({ latest: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(migrationValidationReports.legacyAgencyId, row.legacyAgencyId),
        eq(migrationValidationReports.latest, true),
      ),
    );
  await tx.insert(migrationValidationReports).values({ ...row, latest: true, updatedAt: row.createdAt });
}

const summary = {
  id: migrationValidationReports.id,
  legacyAgencyId: migrationValidationReports.legacyAgencyId,
  targetAgencyId: migrationValidationReports.targetAgencyId,
  status: migrationValidationReports.status,
  legacyRows: migrationValidationReports.legacyRows,
  unexplained: migrationValidationReports.unexplained,
  sampleDiffs: migrationValidationReports.sampleDiffs,
  urlFailures: migrationValidationReports.urlFailures,
  createdAt: migrationValidationReports.createdAt,
};

export type ReportSummaryRow = {
  id: string;
  legacyAgencyId: string;
  targetAgencyId: string;
  status: MigrationValidationStatus;
  legacyRows: number;
  unexplained: number;
  sampleDiffs: number;
  urlFailures: number;
  createdAt: Date;
};

/**
 * Each legacy agency's latest report, newest first, keyset, optionally one status (`…_list_idx` / `…_created_idx`).
 */
export async function listLatest(
  tx: Tx,
  q: { limit: number; cursor?: KeysetCursor; status?: MigrationValidationStatus },
): Promise<ReportSummaryRow[]> {
  const t = migrationValidationReports;
  return (await tx
    .select(summary)
    .from(t)
    .where(
      and(eq(t.latest, true), q.status ? eq(t.status, q.status) : undefined, rowAfter(t.createdAt, t.id, q.cursor)),
    )
    .orderBy(...rowOrder(t.createdAt, t.id))
    .limit(q.limit + 1)) as ReportSummaryRow[];
}

/** One report with its snapshot (PK). */
export async function getReport(
  tx: Tx,
  id: string,
): Promise<(ReportSummaryRow & { report: MigrationValidationReport }) | null> {
  const [row] = await tx
    .select({ ...summary, report: migrationValidationReports.report })
    .from(migrationValidationReports)
    .where(eq(migrationValidationReports.id, id));
  return (row as (ReportSummaryRow & { report: MigrationValidationReport }) | undefined) ?? null;
}
