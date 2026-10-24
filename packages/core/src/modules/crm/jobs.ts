import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { runContactImport, sweepContactImports } from './import';

const IMPORT_ATTEMPTS = 3;

/**
 * crm worker jobs (PATTERNS §12). Idempotent, batched, per-tenant fair share.
 *
 * - `crm.importContacts` (pool `imports`, one per `crm.import.requested` event, job ID = the import's id): streams the
 *   uploaded file in batches of 500 rows, one transaction each, resuming after the import's checkpoint on a retry.
 *   One import per agency at a time.
 * - `crm.sweepContactImports` (pool `maintenance`, daily): expires uploads never started within 24 h and deletes the
 *   files still in storage (those uploads, and finished runs whose own delete failed).
 */
export const crmJobs = {
  importContacts: defineJob({
    name: 'crm.importContacts',
    pool: 'imports',
    payload: z.object({ agencyId: z.uuid(), importId: z.uuid() }),
    jobId: (p) => p.importId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: IMPORT_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 30 * 60_000,
    async run(p, job) {
      return runContactImport(p, { log: job.log, signal: job.signal, lastAttempt: job.attempt >= IMPORT_ATTEMPTS });
    },
  }),

  sweepContactImports: defineJob({
    name: 'crm.sweepContactImports',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const result = await sweepContactImports({ signal });
      if (result.expired > 0 || result.filesDeleted > 0) log.info(result, 'contact import files swept');
      return result;
    },
  }),
};
