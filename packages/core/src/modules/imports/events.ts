import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * imports events (PATTERNS §8), emitted in the transaction that changes the run. IDs only.
 *
 * - `imports.run.requested` — a run was queued (a member's "run now" or the scheduler); the subscription enqueues
 *   `imports.runFeed` with the run's id as job ID.
 * - `imports.run.finished` — a run ended (SUCCEEDED or FAILED), for notifications and anomaly checks (S6-0x).
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
};
