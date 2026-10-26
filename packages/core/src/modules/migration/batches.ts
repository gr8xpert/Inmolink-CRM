/**
 * Checkpointed batches of the legacy load (S14-02, ADR 0006 "per-agency batches are idempotent and resume from the last
 * checkpoint"). An entity's staged rows arrive as batches in staging order (streamed: one batch in memory at a time);
 * each batch runs in its own `withSystem()` transaction and commits together with its checkpoint (`migration_batches`:
 * DONE, counts, issues). A batch that throws is recorded FAILED — its error code, constraint and first legacy id only,
 * never the message (it may quote personal data) — and stops the entity. A re-run skips each DONE batch whose rows are
 * unchanged (its stored counts and issues go into the report) and resumes at the first one that is not: the failed
 * batch, or one whose staging changed. Every load is idempotent on its own (maps, natural keys), so running a batch
 * again (`restart`) creates no duplicate. A run that reaches the end of the entity drops its checkpoints past the
 * last batch (S14 review): a re-extract with fewer rows, or a smaller delta, leaves no stale DONE / FAILED row behind.
 */
import { createHash } from 'node:crypto';
import type { LegacyLoadReport } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { countsOf, failureOf, inSavepoint, mergeInto, newLoadReport } from './load';
import * as repo from './repo';

/** Issues kept per checkpoint (the report of a fresh run lists them all). */
export const CHECKPOINT_MAX_ISSUES = 500;

export interface BatchStep {
  /** Staging entity (`properties`, `contacts`, …): the checkpoint key. */
  entity: string;
  /** Report entities the loader counts (`listing`; `development` and `unit`). */
  reportEntities: readonly string[];
  /** The staged rows, batch by batch, in staging order (the same cut on every run: checkpoints are per batch). */
  batches: AsyncIterable<readonly unknown[]>;
  /** Loads one batch into `report` (a fresh one per batch) in the batch's transaction. */
  load: (tx: Tx, rows: readonly unknown[], report: LegacyLoadReport) => Promise<void>;
}

export interface BatchRunOptions {
  legacyAgencyId: string;
  agencyId: string;
  dryRun: boolean;
  /** Ignore the checkpoints: run every batch again (idempotent). */
  restart: boolean;
}

export interface StepOutcome {
  batches: number;
  /** DONE batches skipped (their counts come from the checkpoint). */
  resumed: number;
  /** The batch that failed (the run stops there): code, constraint and first legacy id. */
  failed: { seq: number; error: string } | null;
}

const hashOf = (rows: readonly unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const firstIdOf = (rows: readonly unknown[]) => {
  const id = (rows[0] as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
};

/** Runs one entity's batches into `report`. Never throws for a batch's failure: it is recorded and returned. */
export async function runBatches(
  opts: BatchRunOptions,
  step: BatchStep,
  report: LegacyLoadReport,
): Promise<StepOutcome> {
  const reason = `legacy-migration.load${opts.dryRun ? '.dry-run' : ''}`;
  for (const e of step.reportEntities) countsOf(report, e);
  const outcome: StepOutcome = { batches: 0, resumed: 0, failed: null };
  const done =
    opts.restart || opts.dryRun
      ? new Map<number, repo.CheckpointRow>()
      : new Map(
          (await withSystem(reason, (tx) => repo.checkpoints(tx, opts.legacyAgencyId, step.entity)))
            .filter((c) => c.status === 'DONE')
            .map((c) => [c.seq, c]),
        );
  let seq = -1;
  for await (const rows of step.batches) {
    seq += 1;
    outcome.batches += 1;
    const inputHash = hashOf(rows);
    const checkpoint = done.get(seq);
    if (checkpoint && checkpoint.inputHash === inputHash) {
      mergeInto(report, checkpoint);
      outcome.resumed += 1;
      continue;
    }
    try {
      const part = await withSystem(reason, async (tx) => {
        const batch = newLoadReport(opts.legacyAgencyId, opts.agencyId, opts.dryRun);
        for (const e of step.reportEntities) countsOf(batch, e);
        await inSavepoint(tx, opts.dryRun, (sp) => step.load(sp, rows, batch));
        if (!opts.dryRun) {
          await repo.saveCheckpoint(tx, {
            legacyAgencyId: opts.legacyAgencyId,
            targetAgencyId: opts.agencyId,
            entity: step.entity,
            seq,
            inputHash,
            status: 'DONE',
            rows: rows.length,
            counts: batch.counts,
            issues: batch.issues.slice(0, CHECKPOINT_MAX_ISSUES),
            error: null,
          });
        }
        return batch;
      });
      mergeInto(report, part);
    } catch (err) {
      const error = failureOf(err, firstIdOf(rows));
      outcome.failed = { seq, error };
      if (!opts.dryRun) {
        await withSystem(reason, (tx) =>
          repo.saveCheckpoint(tx, {
            legacyAgencyId: opts.legacyAgencyId,
            targetAgencyId: opts.agencyId,
            entity: step.entity,
            seq,
            inputHash,
            status: 'FAILED',
            rows: rows.length,
            counts: {},
            issues: [],
            error,
          }),
        );
      }
      break;
    }
  }
  if (!outcome.failed && !opts.dryRun) {
    await withSystem(reason, (tx) => repo.deleteCheckpointsAfter(tx, opts.legacyAgencyId, step.entity, seq));
  }
  return outcome;
}
