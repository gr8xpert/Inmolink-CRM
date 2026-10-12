import { withSystem } from '@inmolink/db';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as repo from './repo';

/** pg_partman's own advice is to run maintenance more often than the smallest interval: hourly is plenty. */
export const PARTITION_MAINTENANCE_EVERY_MS = 60 * 60_000;

/**
 * compliance worker jobs (PATTERNS §12).
 *
 * Schedule: `compliance.maintainPartitions` every hour (platform recurring job, S1-F4). It runs
 * pg_partman's maintenance for every partitioned table (audit_logs today; activities, notifications and
 * stats later), which keeps the current month plus the next 4 created (`premake`). Idempotent: a run with
 * nothing to create changes nothing. Retention is off — no partition is dropped (STATUS Decisions, S1-08).
 */
export const complianceJobs = {
  maintainPartitions: defineJob({
    name: 'compliance.maintainPartitions',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: PARTITION_MAINTENANCE_EVERY_MS,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run() {
      await withSystem('compliance.maintainPartitions', (tx) => repo.runPartitionMaintenance(tx), { routine: true });
      return { ok: true };
    },
  }),
};
