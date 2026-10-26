/**
 * migration worker jobs (PATTERNS §12): `defineJob({ name: 'migration.<verb><Entity>', … })` from
 * `@inmolink/platform/queue`. Idempotent, batched, per-tenant fair share.
 *
 * `migration.flushRedirectHits` (S14-05, schedule: every minute): writes the legacy-redirect hit counters — those the
 * resolving processes (S15-02: the portal's public pages) pushed to the shared counters on redis-cache
 * (`pushRedirectHits`), and the worker process's own buffer.
 *
 * `migration.scheduleLegacyDeltas` (S14-04, schedule: hourly, pool `maintenance`): queues one
 * `migration.syncLegacyDelta` per migrated legacy agency not cut over (`deltaAgencies`, `enqueueMany` per page), job
 * id `delta:<legacy agency>:<hour slot>` (a repeated tick queues nothing new). A no-op until a legacy reader is
 * registered (`registerLegacyDeltaSource`; the legacy connection is H1).
 * `migration.syncLegacyDelta` (pool `maintenance`, fair share by agency, one per agency at a time, at most
 * `DELTA_CONCURRENCY` across the pool): opens the agency's legacy snapshot and runs `syncLegacyDelta` — batched
 * (one transaction and checkpoint per batch), idempotent (a re-run re-reads from the same watermark).
 */
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { DELTA, deltaAgencies, legacyDeltaSourceFactory, syncLegacyDelta } from './delta';
import { flushRedirectHits } from './redirects';

/** Deltas running at once across the maintenance pool (each holds a legacy read snapshot open). */
const DELTA_CONCURRENCY = 2;

const syncLegacyDeltaJob = defineJob({
  name: 'migration.syncLegacyDelta',
  pool: 'maintenance',
  payload: z
    .object({ legacyAgencyId: z.string().min(1).max(100), agencyId: z.uuid(), slot: z.number().int() })
    .strict(),
  jobId: (p) => `delta:${p.legacyAgencyId}:${p.slot}`,
  group: (p) => p.agencyId,
  concurrencyPerGroup: 1,
  globalConcurrency: DELTA_CONCURRENCY,
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  // Within the hour: the next slot's delta reads from the same watermark when this one did not finish.
  timeoutMs: 50 * 60_000,
  async run(p, { log }) {
    const open = legacyDeltaSourceFactory();
    if (!open) return { skipped: 'NO_SOURCE' };
    const source = await open(p.legacyAgencyId);
    try {
      const r = await syncLegacyDelta({ legacyAgencyId: p.legacyAgencyId, agencyId: p.agencyId, source });
      const summary = {
        legacyAgencyId: p.legacyAgencyId,
        skipped: r.skipped,
        counts: r.load?.report.counts,
        stoppedAt: r.load?.stoppedAt ?? null,
        withdrawn: r.withdrawn,
        withdrawGuard: r.withdrawGuard,
      };
      if (summary.stoppedAt || r.withdrawGuard) log.warn(summary, 'legacy delta needs staff attention');
      else log.info(summary, 'legacy delta done');
      return { skipped: r.skipped, stopped: summary.stoppedAt !== null, withdrawn: r.withdrawn };
    } finally {
      await source.close();
    }
  },
});

export const migrationJobs = {
  syncLegacyDelta: syncLegacyDeltaJob,
  scheduleLegacyDeltas: defineJob({
    name: 'migration.scheduleLegacyDeltas',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: DELTA.INTERVAL_MS,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log }) {
      if (!legacyDeltaSourceFactory()) return { queued: 0, skipped: 'NO_SOURCE' };
      const slot = Math.floor(Date.now() / DELTA.INTERVAL_MS);
      let queued = 0;
      for await (const page of deltaAgencies()) {
        await syncLegacyDeltaJob.enqueueMany(page.map((a) => ({ payload: { ...a, slot } })));
        queued += page.length;
      }
      log.info({ queued, slot }, 'legacy deltas queued');
      return { queued };
    },
  }),
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
