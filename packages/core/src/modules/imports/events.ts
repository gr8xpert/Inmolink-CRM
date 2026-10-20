import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * imports events (PATTERNS §8), emitted in the transaction that changes the run. IDs only.
 *
 * - `imports.run.requested` — a run was queued (a member's "run now" or the scheduler); the subscription enqueues
 *   `imports.runFeed` with the run's id as job ID.
 * - `imports.run.finished` — a run ended (SUCCEEDED or FAILED), for notifications and anomaly checks (S6-0x).
 * - `imports.connection.paused` — the anomaly guard paused a connection (S6-08): the agency notice (in-app and email
 *   once notifications land, S11-04); the connection itself shows the pause meanwhile.
 */
export const importsEvents = {
  runRequested: defineEvent(
    'imports.run.requested',
    1,
    z.object({ runId: z.uuid(), connectionId: z.uuid(), agencyId: z.uuid() }),
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
      reason: z.enum(['VOLUME_SPIKE', 'MASS_WITHDRAWAL']),
    }),
  ),
};
