/**
 * migration worker jobs (PATTERNS §12): `defineJob({ name: 'migration.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 *
 * `migration.flushRedirectHits` (S14-05, schedule: every minute): writes the legacy-redirect hit counters — those the
 * resolving processes (S15-02: the portal's public pages) pushed to the shared counters on redis-cache
 * (`pushRedirectHits`), and the worker process's own buffer.
 *
 * S17-F4: the hourly legacy delta jobs (schedule + per-agency sync, S14-04 / S15-F4) are
 * retired with the parallel run: the old system never runs beside v2. A delta from a later restored dump is the
 * operator's (`pnpm legacy:delta`, the cutover's `FINAL_DELTA`).
 */
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { flushRedirectHits, REDIRECT_HITS_FLUSH_TIMEOUT_MS } from './redirects';

export const migrationJobs = {
  flushRedirectHits: defineJob({
    name: 'migration.flushRedirectHits',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 60_000,
    // S16-F3: one flush at a time; overlaps (a timed-out run still going, a stalled re-run) are fenced by the lease on
    // the taken counters, and the job's signal stops a timed-out flush before it commits.
    globalConcurrency: 1,
    attempts: 3,
    timeoutMs: REDIRECT_HITS_FLUSH_TIMEOUT_MS,
    async run(_p, { signal, log }) {
      await flushRedirectHits({ signal, log });
    },
  }),
};
