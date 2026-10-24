import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * imports events (PATTERNS §8), emitted in the transaction that changes the run. IDs only.
 *
 * - `imports.run.requested` — a run was queued (a member's "run now" or the scheduler); the subscription enqueues
 *   `imports.runFeed` with the run's id as job ID. S7-F12: also when a resumable run handed its slot back after a
 *   slice (`resume`: a new job for the same run, from its checkpoint).
 * - `imports.run.finished` — a run ended (SUCCEEDED or FAILED), for notifications and anomaly checks (S6-0x).
 * - `imports.connection.paused` — the anomaly guard paused a connection (S6-08): S12-F2 raises the agency's notice
 *   from it — an `IMPORT_PAUSED` notification to its admins (in-app and the e-mail digest); the connection itself shows
 *   the pause too. S7-F1 adds `EMPTY_FEED`.
 * - `imports.sheet.released` — an uploaded sheet lost its connection (S7-F1: the connection was deleted, or a new
 *   upload replaced its file); the subscription deletes the file from storage after the commit, unless another
 *   connection of the agency still points at it.
 */
export const importsEvents = {
  runRequested: defineEvent(
    'imports.run.requested',
    1,
    z.object({
      runId: z.uuid(),
      connectionId: z.uuid(),
      agencyId: z.uuid(),
      /** S7-F12: the run's next slice — the claim number that handed it back (the job id's suffix). */
      resume: z.number().int().min(1).optional(),
    }),
  ),
  runFinished: defineEvent(
    'imports.run.finished',
    1,
    z.object({
      runId: z.uuid(),
      connectionId: z.uuid(),
      agencyId: z.uuid(),
      state: z.enum(['SUCCEEDED', 'FAILED']),
      errorCode: z.string().nullable(),
    }),
  ),
  connectionPaused: defineEvent(
    'imports.connection.paused',
    1,
    z.object({
      connectionId: z.uuid(),
      agencyId: z.uuid(),
      runId: z.uuid(),
      reason: z.enum(['VOLUME_SPIKE', 'MASS_WITHDRAWAL', 'EMPTY_FEED']),
    }),
  ),
  sheetReleased: defineEvent(
    'imports.sheet.released',
    1,
    z.object({ agencyId: z.uuid(), fileId: z.uuid(), connectionId: z.uuid() }),
  ),
};
