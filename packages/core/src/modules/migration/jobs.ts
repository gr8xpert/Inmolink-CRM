/**
 * migration worker jobs (PATTERNS §12): `defineJob({ name: 'migration.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 *
 * `migration.flushRedirectHits` (S14-05, schedule: every minute): writes the legacy-redirect hit counters buffered in
 * this process's memory. The portal / feed-api processes that resolve redirects call `flushRedirectHits` on their own
 * interval; this job covers the worker process (plugin shim calls made there) and is a no-op when nothing is buffered.
 */
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { flushRedirectHits } from './redirects';

export const migrationJobs = {
  flushRedirectHits: defineJob({
    name: 'migration.flushRedirectHits',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60_000,
    attempts: 3,
    timeoutMs: 60_000,
    async run() {
      await flushRedirectHits();
    },
  }),
};
