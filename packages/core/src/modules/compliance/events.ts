import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * compliance events (PATTERNS §8): `defineEvent('compliance.<entity>.<verb>', 1, schema)` from
 * `@inmolink/platform/outbox`, emitted with `emit(ctx.tx, …)` in the same transaction. IDs only.
 *
 * - `compliance.dataExport.requested` (S10-08) — an admin asked for a data export; the worker's subscription
 *   (`compliance/worker.ts`) queues `compliance.runDataExport` (job ID = the export's id).
 */
export const complianceEvents = {
  dataExportRequested: defineEvent(
    'compliance.dataExport.requested',
    1,
    z.object({ agencyId: z.uuid(), exportId: z.uuid() }),
  ),
};
