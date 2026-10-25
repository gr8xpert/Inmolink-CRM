import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import {
  backfillListingStates,
  INSTANT_WINDOW_MS,
  matchListings,
  pendingAlertAgencies,
  pruneMatching,
  rekeyAgency,
  savedSearchAgencies,
  sendAlerts,
} from './service';

/** The daily sweeps spread the agencies' jobs over this long (stable per agency), not all at once. */
export const SWEEP_SPREAD_MS = 60 * 60_000;
/** INSTANT alerts older than this with no send queued (Redis was down) are picked up by `sweepAlerts`. */
export const STALE_INSTANT_MS = 2 * INSTANT_WINDOW_MS;

/** A stable delay in [0, SWEEP_SPREAD_MS) per agency (its id's last hex digits). */
export const sweepDelayOf = (agencyId: string): number =>
  Number.parseInt(agencyId.replace(/-/g, '').slice(-8), 16) % SWEEP_SPREAD_MS;

const day = () => new Date().toISOString().slice(0, 10);

/**
 * matching worker jobs (PATTERNS §12, pool `matching`). Idempotent, batched, per-tenant fair share.
 *
 * - `matching.matchListings` — one per `search.listings.changed` event (job ID = the event's id; group = the listings'
 *   agency): the event's listings against the saved searches; then queues `sendAlerts` (INSTANT, throttled
 *   `INSTANT_WINDOW_MS`) for every agency it alerted. A retry alerts nobody twice (the alerts' unique key).
 * - `matching.sendAlerts` — per agency and frequency (group = the agency): its waiting alerts, re-checked, as one
 *   notification per member; INSTANT ones throttled to one run per `INSTANT_WINDOW_MS` (a short digest), DAILY ones
 *   once a day (job ID per day). Runs again while more are waiting.
 * - `matching.sweepAlerts` — every 15 minutes: queues `sendAlerts` INSTANT for agencies whose alerts have waited longer
 *   than `STALE_INSTANT_MS` (their queued send was lost).
 * - `matching.sweepDigests` — every 24 hours: queues each agency's DAILY `sendAlerts` (spread over `SWEEP_SPREAD_MS`).
 * - `matching.rekeyAgency` — per agency: its searches' keys follow its network standing (queued on
 *   `agencies.status.changed` and by `matching.sweepRekey`, every 24 hours, for every agency with saved searches:
 *   give-to-get standing changes with sharing and the grace period's end).
 * - `matching.pruneAlerts` — every 24 hours: alerts older than 90 days, states of listings gone 180 days.
 * - `matching.backfillListingStates` — queued once after deploy (`{ after: null }`): every existing listing's state,
 *   5,000 per run, each run queueing the next.
 */
export const matchingJobs = {
  matchListings: defineJob({
    name: 'matching.matchListings',
    pool: 'matching',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      listingIds: z.array(z.uuid()).min(1).max(100),
    }),
    jobId: (p) => `match:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const result = await matchListings(p);
      // after the commit: a lost enqueue is picked up by `sweepAlerts`
      if (result.agencies.length > 0) {
        await matchingJobs.sendAlerts.enqueueMany(
          result.agencies.map((agencyId) => ({
            payload: { agencyId, frequency: 'INSTANT' as const },
            options: { throttleMs: INSTANT_WINDOW_MS },
          })),
        );
        log.info({ transitions: result.transitions, alerts: result.alerts }, 'saved search alerts raised');
      }
      return { transitions: result.transitions, alerts: result.alerts };
    },
  }),

  sendAlerts: defineJob({
    name: 'matching.sendAlerts',
    pool: 'matching',
    payload: z.object({
      agencyId: z.uuid(),
      frequency: z.enum(['INSTANT', 'DAILY']),
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    // DAILY: one per agency and day; INSTANT: the throttle's key (enqueued with `throttleMs`)
    jobId: (p) => `${p.frequency.toLowerCase()}:${p.agencyId}:${p.day ?? ''}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 120_000,
    async run(p, { log, signal }) {
      let notified = 0;
      let dropped = 0;
      for (;;) {
        const r = await sendAlerts(p.agencyId, p.frequency);
        notified += r.notified;
        dropped += r.dropped;
        if (!r.more || signal.aborted) break;
      }
      if (notified > 0 || dropped > 0) log.info({ notified, dropped }, 'saved search alerts sent');
      return { notified, dropped };
    },
  }),

  sweepAlerts: defineJob({
    name: 'matching.sweepAlerts',
    pool: 'matching',
    payload: z.object({}).strict(),
    every: 15 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log, signal }) {
      let after: string | null = null;
      let queued = 0;
      const olderThan = new Date(Date.now() - STALE_INSTANT_MS);
      while (!signal.aborted) {
        const page = await pendingAlertAgencies(after, olderThan);
        if (page.length === 0) break;
        await matchingJobs.sendAlerts.enqueueMany(
          page.map((agencyId) => ({
            payload: { agencyId, frequency: 'INSTANT' as const },
            options: { throttleMs: INSTANT_WINDOW_MS },
          })),
        );
        queued += page.length;
        after = page.at(-1) ?? null;
      }
      if (queued > 0) log.info({ queued }, 'waiting saved search alerts queued');
      return { queued };
    },
  }),

  sweepDigests: defineJob({
    name: 'matching.sweepDigests',
    pool: 'matching',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const today = day();
      let after: string | null = null;
      let queued = 0;
      while (!signal.aborted) {
        const page = await pendingAlertAgencies(after);
        if (page.length === 0) break;
        await matchingJobs.sendAlerts.enqueueMany(
          page.map((agencyId) => ({
            payload: { agencyId, frequency: 'DAILY' as const, day: today },
            options: { delayMs: sweepDelayOf(agencyId) },
          })),
        );
        queued += page.length;
        after = page.at(-1) ?? null;
      }
      log.info({ queued }, 'saved search digests queued');
      return { queued };
    },
  }),

  rekeyAgency: defineJob({
    name: 'matching.rekeyAgency',
    pool: 'matching',
    payload: z.object({ agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const r = await rekeyAgency(p.agencyId);
      if (r.changed > 0) log.info(r, 'saved search keys rewritten');
      return r;
    },
  }),

  sweepRekey: defineJob({
    name: 'matching.sweepRekey',
    pool: 'matching',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      let after: string | null = null;
      let queued = 0;
      while (!signal.aborted) {
        const page = await savedSearchAgencies(after);
        if (page.length === 0) break;
        await matchingJobs.rekeyAgency.enqueueMany(
          page.map((agencyId) => ({ payload: { agencyId }, options: { delayMs: sweepDelayOf(agencyId) } })),
        );
        queued += page.length;
        after = page.at(-1) ?? null;
      }
      log.info({ queued }, 'saved search re-keys queued');
      return { queued };
    },
  }),

  pruneAlerts: defineJob({
    name: 'matching.pruneAlerts',
    pool: 'matching',
    payload: z.object({}).strict(),
    every: 24 * 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log }) {
      const pruned = await pruneMatching();
      log.info(pruned, 'old saved search alerts pruned');
      return pruned;
    },
  }),

  backfillListingStates: defineJob({
    name: 'matching.backfillListingStates',
    pool: 'matching',
    payload: z.object({ after: z.uuid().nullable() }),
    jobId: (p) => `backfill-states:${p.after ?? 'start'}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 120_000,
    async run(p, { log }) {
      const r = await backfillListingStates(p.after);
      if (r.next) await matchingJobs.backfillListingStates.enqueue({ after: r.next });
      else log.info('matching listing states backfilled');
      return r;
    },
  }),
};
