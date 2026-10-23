import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * exports events (PATTERNS §8), emitted in the transaction that changes the connection. IDs only.
 *
 * - `exports.connection.changed` (S9-01) — a portal connection was created, changed (name, enabled, selection rule),
 *   had its per-property choices changed (`SELECTION_CHANGED`), or its token was rotated or revoked, or it was
 *   deleted; `version` is the new one. The feed generator (S9-03) regenerates the connection's files on it.
 */
export const exportsEvents = {
  connectionChanged: defineEvent(
    'exports.connection.changed',
    1,
    z.object({
      connectionId: z.uuid(),
      agencyId: z.uuid(),
      action: z.enum(['CREATED', 'UPDATED', 'SELECTION_CHANGED', 'TOKEN_ROTATED', 'TOKEN_REVOKED', 'DELETED']),
      version: z.number().int(),
    }),
  ),
};
