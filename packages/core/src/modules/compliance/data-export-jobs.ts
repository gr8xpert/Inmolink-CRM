import { mailer } from '@inmolink/platform/email';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { dataExportNoticeRecipients, renderDataExportNotice } from './data-export-notice';
import { runDataExport, sweepDataExports } from './data-export-run';

const EXPORT_ATTEMPTS = 3;

/**
 * Data export worker jobs (S10-08, PATTERNS §12) — worker-only (`compliance/worker.ts`): they read other modules'
 * tables, which the request-side `index.ts` must not import.
 *
 * - `compliance.runDataExport` (pool `exports`, one per `compliance.dataExport.requested` event, job ID = the export's
 *   id): streams the export's file to storage (`data-export-run.ts`). Per-tenant fair share: one export per agency at a
 *   time (`group`, `concurrencyPerGroup` 1 — and the database allows one queued or running per agency), at most two per
 *   worker process and four across the pool, so exports never hold the slots the portal and site feeds need.
 *   Idempotent: a redelivered event adds nothing (job ID); a retry claims the row again and rewrites the file. Progress
 *   is reported per page.
 * - `compliance.notifyDataExport` (pool `email`, one per `compliance.dataExport.requested` event): fans the alert out,
 *   one `compliance.sendDataExportNotice` per active admin (job ID = export + admin: sent once each), in one bulk add.
 *   Both carry the agency as their fair-share `group` (S11-F8): one agency's alerts never starve another's e-mail.
 * - `compliance.sweepDataExports` (pool `maintenance`, daily): deletes expired files, fails lost runs.
 */
export const dataExportJobs = {
  runDataExport: defineJob({
    name: 'compliance.runDataExport',
    pool: 'exports',
    payload: z.object({ agencyId: z.uuid(), exportId: z.uuid() }),
    jobId: (p) => p.exportId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    perProcessConcurrency: 2,
    globalConcurrency: 4,
    attempts: EXPORT_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 60 * 60_000,
    async run(p, job) {
      return runDataExport(p, {
        log: job.log,
        signal: job.signal,
        lastAttempt: job.attempt >= EXPORT_ATTEMPTS,
        progress: job.progress,
      });
    },
  }),

  notifyDataExport: defineJob({
    name: 'compliance.notifyDataExport',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), exportId: z.uuid() }),
    jobId: (p) => `data-export-notify:${p.exportId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p) {
      const admins = await dataExportNoticeRecipients(p);
      if (admins.length > 0) {
        await dataExportJobs.sendDataExportNotice.enqueueMany(admins.map((userId) => ({ payload: { ...p, userId } })));
      }
      return { queued: admins.length };
    },
  }),

  sendDataExportNotice: defineJob({
    name: 'compliance.sendDataExportNotice',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), exportId: z.uuid(), userId: z.uuid() }),
    jobId: (p) => `data-export-notice:${p.exportId}:${p.userId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const message = await renderDataExportNotice(p);
      if (!message) return { sent: false };
      // Outside any transaction (CLAUDE.md rule 6).
      await mailer().send(message);
      log.info({ exportId: p.exportId }, 'data export notice sent');
      return { sent: true };
    },
  }),

  sweepDataExports: defineJob({
    name: 'compliance.sweepDataExports',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const result = await sweepDataExports({ signal });
      if (result.failed > 0 || result.deleted > 0) log.info(result, 'data exports swept');
      return result;
    },
  }),
};
