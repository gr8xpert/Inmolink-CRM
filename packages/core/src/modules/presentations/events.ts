import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * presentations events (PATTERNS §8): `defineEvent('presentations.<entity>.<verb>', 1, schema)`, emitted in the same
 * transaction. IDs only.
 *
 * - `presentations.selection.interacted` (S12-04) — a client viewed a selection's page, liked (or unliked) or
 *   enquired about an item: written by the public pages as `app_intake` with the interaction. The worker puts it on
 *   the CRM timeline of the selection's contact (and of the agency's own listing).
 */
export const presentationsEvents = {
  selectionInteracted: defineEvent(
    'presentations.selection.interacted',
    1,
    z.object({
      selectionId: z.uuid(),
      interactionId: z.uuid(),
      kind: z.enum(['VIEW', 'LIKE', 'UNLIKE', 'ENQUIRE']),
      targetId: z.uuid().nullable(),
    }),
  ),
};
