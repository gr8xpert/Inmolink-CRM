import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { pruneLeadIdempotency } from './leads';

/**
 * websites worker jobs (PATTERNS §12): `defineJob({ name: 'websites.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 *
 * `websites.pruneLeadIdempotency` (schedule: every hour, S7-05): clears inbound leads' idempotency keys past the
 * 24 h replay window, in batches of 5,000.
 */
export const websitesJobs = {
  pruneLeadIdempotency: defineJob({
    name: 'websites.pruneLeadIdempotency',
    pool: 'maintenance',
    payload: z.object({}),
    every: 3_600_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 300_000,
    async run(_p, { log }) {
      const cleared = await pruneLeadIdempotency(clock.now());
      if (cleared > 0) log.info({ cleared }, 'website lead idempotency keys cleared');
      return { cleared };
    },
  }),
};
