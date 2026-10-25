import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { pruneLeadIdempotency } from './leads';
import { agenciesWithSites, syncSitePlan } from './service';

/**
 * websites worker jobs (PATTERNS §12): `defineJob({ name: 'websites.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 *
 * `websites.pruneLeadIdempotency` (schedule: every hour, S7-05): clears inbound leads' idempotency keys past the
 * 24 h replay window, in batches of 5,000.
 *
 * S13-F21: `websites.syncSitePlan` records an agency's plan in force on its sites (AI budgets of the website API, the
 * 402 cut-off of a plan without `website_api`), on billing's plan events and a site's creation; `websites.syncSitePlans`
 * (daily) re-syncs every agency with sites — the backfill, and plan changes no event announces (a past-due
 * subscription's dunning grace running out).
 */
/** Agencies per page of the daily site-plan sweep. */
const SWEEP_PAGE = 500;

const syncSitePlanJob = defineJob({
  name: 'websites.syncSitePlan',
  pool: 'maintenance',
  // `key`: the event id or the sweep run (a later sync of the same agency is a new job).
  payload: z.object({ agencyId: z.uuid(), key: z.string().min(1).max(80) }).strict(),
  jobId: (p) => `websites.syncSitePlan:${p.key}:${p.agencyId}`,
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  timeoutMs: 60_000,
  async run(p) {
    return syncSitePlan(p.agencyId);
  },
});

export const websitesJobs = {
  syncSitePlan: syncSitePlanJob,

  syncSitePlans: defineJob({
    name: 'websites.syncSitePlans',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 86_400_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 600_000,
    async run(_p, { log, signal }) {
      const run = `sweep-${clock.now().toISOString().slice(0, 10)}`;
      let after: string | null = null;
      let agencies = 0;
      for (;;) {
        const page = await agenciesWithSites(after, SWEEP_PAGE);
        await syncSitePlanJob.enqueueMany(page.map((agencyId) => ({ payload: { agencyId, key: run } })));
        agencies += page.length;
        after = page.at(-1) ?? null;
        if (page.length < SWEEP_PAGE || signal.aborted) break;
      }
      log.info({ agencies }, 'site plans queued');
      return { agencies };
    },
  }),

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
