import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * support events (PATTERNS §8), emitted in the same transaction. IDs only. Internal notes never emit an event: no
 * subscriber (and so no e-mail) can ever carry one.
 */
export const supportEvents = {
  /**
   * S13-05: a message the agency can see was posted — the first message of a new ticket, a member's reply
   * (`AGENCY`: the support inbox is told) or a staff reply (`STAFF`: the member who opened the ticket is told).
   */
  messagePosted: defineEvent(
    'support.message.posted',
    1,
    z.object({
      ticketId: z.uuid(),
      messageId: z.uuid(),
      author: z.enum(['AGENCY', 'STAFF']),
      /** The ticket's first message (the ticket was just opened). */
      isNew: z.boolean(),
    }),
  ),
};
