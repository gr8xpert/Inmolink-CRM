import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * documents events (PATTERNS §8).
 *
 * - `documents.form.created` (R2-05a) — a member made a form document (`PENDING`): its render is queued
 *   (`subscriptions.ts`). Ids only.
 */
export const documentsEvents = {
  formCreated: defineEvent('documents.form.created', 1, z.object({ agencyId: z.uuid(), formId: z.uuid() })),
};
