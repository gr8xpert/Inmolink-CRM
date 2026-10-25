import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { pruneSelectionInteractions } from './retention';

/**
 * presentations worker jobs (PATTERNS §12).
 *
 * - `presentations.pruneInteractions` (pool `maintenance`, daily, S13-F9): the interactions of selections ended past
 *   their retention (`retention.ts`).
 */
export const presentationsJobs = {
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
