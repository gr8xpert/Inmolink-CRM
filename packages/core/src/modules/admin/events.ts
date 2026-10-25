import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * admin events (PATTERNS §8): `defineEvent('admin.<entity>.<verb>', 1, schema)` from
 * `@inmolink/platform/outbox`, emitted with `emit(ctx.tx, …)` in the same transaction. IDs only.
 */
export const adminEvents = {
  /**
   * S13-03: staff started a bulk operation (a platform event: nil agency). Its subscription queues the
   * `admin.runStaffOperation` job once the starting transaction committed.
   */
  operationRequested: defineEvent('admin.operation.requested', 1, z.object({ operationId: z.uuid() })),
};
