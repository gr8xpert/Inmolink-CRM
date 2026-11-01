import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as crm from '../crm';
import { eraseContactSelections } from './erasure';
import { pruneSelectionInteractions } from './retention';

/**
 * presentations worker jobs (PATTERNS §12).
 *
 * - `presentations.eraseContactSelections` (pool `maintenance`, one per `crm.contact.erased` event, S16-04 review): the
 *   erased contact's (and merged contacts') selections are revoked and lose their texts and interactions. Idempotent.
 * - `presentations.pruneInteractions` (pool `maintenance`, daily, S13-F9): the interactions of selections ended past
 *   their retention (`retention.ts`).
 */
export const presentationsJobs = {
  eraseContactSelections: defineJob({
    name: 'presentations.eraseContactSelections',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), contactId: z.uuid() }),
    jobId: (p) => `selections-erase:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      const contactIds = await crm.erasedContactIds({ agencyId: p.agencyId, contactId: p.contactId });
      return eraseContactSelections({ agencyId: p.agencyId, contactIds });
    },
  }),

  pruneInteractions: defineJob({
    name: 'presentations.pruneInteractions',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const res = await pruneSelectionInteractions(undefined, signal);
      if (res.deleted) log.info(res, 'selection interactions pruned');
      return res;
    },
  }),
};
