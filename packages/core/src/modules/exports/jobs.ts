/**
 * exports worker jobs (PATTERNS §12), pool `exports` (S9-03). Exported through the worker-only entry (`./worker`):
 * the generator reads every agency's tables as `app_system`, so neither the jobs nor what they import are part of the
 * module's public `index.ts` (S9-02).
 *
 * `exports.generatePortalFeeds` — one pass over an agency's portal connections (`generator.ts`): every live one
 * (`connectionId` absent: a listing change, the nightly run) or one (a connection change). Grouped per agency with
 * `concurrencyPerGroup` 1 — runs of one connection never overlap, and an agency's portal and site feed runs take one
 * slot of the pool at a time (per-tenant fair share). Throttled:
 * per agency for listing changes (`queueAgencyPortalFeeds`, 5 minutes after the first), per connection for its own
 * changes (`queueConnectionPortalFeed`, 1 minute, at once for a new connection or token).
 *
 * **Nightly lanes** (S9-03 review, `exports.generateNightlyPortalFeeds`): the night is `nightlyLanes` chains, never
 * thousands of queued jobs. Agencies split
 * into lanes by a hash of their id; each lane runs its agencies one at a time in id order — a nightly job, when it is
 * done (or failed for good), enqueues the next agency of its lane still due tonight. At most `nightlyLanes` nightly
 * jobs exist at once, so none is picked up only to bounce off a cap, and the pool's other jobs (site feeds, event
 * passes) find free slots all night. Each job id is stable per agency and night: re-enqueueing is a no-op.
 *
 * **One budget for the pool's heavy jobs** (S9 review): event passes, nightly passes, push runs and site feeds
 * (`websiteApi.generateSiteFeed`) share one cap group (`EXPORTS_FEED_CAP_GROUP`): at most `runsPerProcess` of them at
 * once in one worker process (memory: each feed being written holds a 5 MiB upload part), at most `maxConcurrentRuns`
 * across the pool (database load: other pools and request paths keep their share). The lanes count against both caps:
 * `nightlyLanes` < `maxConcurrentRuns` (checked at boot) leaves the rest of the pool-wide cap to the other heavy jobs at
 * night, and a nightly job hands its slots back before it enqueues its successor (`releaseCapSlots`), so a lane never
 * bounces off its own predecessor. A nightly job can still find its process full (another heavy job took the slot) and
 * go back to delayed — at most the lanes' few jobs, with growing delays, never the night's queue: size the pool so
 * processes × `runsPerProcess` ≥ `maxConcurrentRuns`.
 *
 * `exports.sweepNightlyPortalFeeds` — every 15 minutes; inside the nightly window (`nightlyHourUtc` + up to
 * `NIGHTLY_CATCH_UP_HOURS`) it seeds — or repairs — the lanes: the first agency of each lane still due (one
 * statement). A running lane's first due agency is the one it is processing, so the seed is a no-op; a broken chain
 * (a worker lost between a pass and its next enqueue) restarts at its first due agency. A full pass after the window
 * opened (listing changes) counts as the night's run (`nightly_at`).
 */
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob, type JobContext, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as websiteApi from '../website-api';
import { PortalFeedError } from './feed-error';
import { generatePortalFeeds } from './generator';
import { pushPortalListings } from './push/engine';
import * as repo from './repo';

/** A listing change (any of the agency's connections may send it): one pass this long after the first change. */
export const PORTAL_FEED_THROTTLE_MS = 5 * 60_000;
/** A connection's own change (selection, setup): one run this long after the first. */
export const PORTAL_FEED_CONNECTION_THROTTLE_MS = 60_000;
/** A new connection or token: a run within seconds. */
export const PORTAL_FEED_SOON_MS = 5_000;
/** A push run (idealista, Fotocasa) this long after the feed pass that found a push connection (S9-04). */
export const PORTAL_PUSH_THROTTLE_MS = 30_000;
/** A run that stopped on its call or time budget continues this long after. */
export const PORTAL_PUSH_CONTINUE_MS = 60_000;
/** Runs of a pass before it gives up (each failure is in the run history). */
export const PORTAL_FEED_ATTEMPTS = 3;
/** A pass's time limit (the perf test checks a 20,000-listing agency against it). */
export const PORTAL_FEED_TIMEOUT_MS = 10 * 60_000;
/** The sweep keeps seeding missed lanes this long after the window opened (a worker outage at night). */
export const NIGHTLY_CATCH_UP_HOURS = 6;

export interface PortalFeedJobsConfig {
  /** UTC hour the nightly run starts (0–23). */
  nightlyHourUtc: number;
  /** Nightly chains at once (< `maxConcurrentRuns`: event passes, push runs and site feeds keep the rest of the cap). */
  nightlyLanes: number;
  /** Heavy jobs (passes, push runs, site feeds) at once across the pool (database load). */
  maxConcurrentRuns: number;
  /** Heavy jobs at once in one worker process (memory: one upload part per connection being written). */
  runsPerProcess: number;
}

export const DEFAULT_PORTAL_FEED_JOBS: PortalFeedJobsConfig = {
  nightlyHourUtc: 2,
  nightlyLanes: 6,
  maxConcurrentRuns: 8,
  runsPerProcess: 2,
};

let jobsConfig: PortalFeedJobsConfig = DEFAULT_PORTAL_FEED_JOBS;

/** Boot (worker): the nightly hour, lanes and the pool caps (validated by `portalFeedsEnv`). */
export function configurePortalFeedJobs(next: Partial<PortalFeedJobsConfig>): void {
  const merged = { ...DEFAULT_PORTAL_FEED_JOBS, ...next };
  if (!Number.isInteger(merged.nightlyHourUtc) || merged.nightlyHourUtc < 0 || merged.nightlyHourUtc > 23) {
    throw new RangeError('exports: nightlyHourUtc must be an integer 0-23');
  }
  for (const k of ['nightlyLanes', 'maxConcurrentRuns', 'runsPerProcess'] as const) {
    if (!Number.isInteger(merged[k]) || merged[k] < 1) throw new RangeError(`exports: ${k} must be a positive integer`);
  }
  // S9 review: the lanes share the pool-wide cap with event passes, push runs and site feeds: leave them a slot.
  if (merged.nightlyLanes >= merged.maxConcurrentRuns) {
    throw new RangeError('exports: nightlyLanes must be less than maxConcurrentRuns');
  }
  websiteApi.configureFeedRunCaps({
    runsPerProcess: merged.runsPerProcess,
    maxConcurrentRuns: merged.maxConcurrentRuns,
  });
  jobsConfig = merged;
}

export const portalFeedJobsConfig = (): PortalFeedJobsConfig => jobsConfig;

/**
 * The nightly window `now` falls in: its start (today's `hour`:00 UTC, or yesterday's before it) and whether the
 * sweep still seeds (within `NIGHTLY_CATCH_UP_HOURS` of the start). Pure.
 */
export function nightlyWindow(now: Date, hourUtc: number): { start: Date; day: string; open: boolean } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (start.getTime() > now.getTime()) start.setUTCDate(start.getUTCDate() - 1);
  const open = now.getTime() - start.getTime() < NIGHTLY_CATCH_UP_HOURS * 3_600_000;
  return { start, day: start.toISOString().slice(0, 10), open };
}

/** The start of the nightly window of `day` (`YYYY-MM-DD`). */
const windowStartOf = (day: string) => new Date(`${day}T${String(jobsConfig.nightlyHourUtc).padStart(2, '0')}:00:00Z`);

const generatePayload = z.object({
  agencyId: z.uuid(),
  /** One connection (its own change); absent: every live one. */
  connectionId: z.uuid().optional(),
});

const nightlyPayload = z.object({
  agencyId: z.uuid(),
  /** The night (`YYYY-MM-DD`): with the agency, the stable job id. */
  nightly: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The lane and lane count the chain continues in. */
  lane: z.number().int().min(0),
  lanes: z.number().int().min(1),
});
type NightlyPayload = z.output<typeof nightlyPayload>;

/** One pass and its job result (both job kinds). */
async function pass(
  agencyId: string,
  opts: { connectionId?: string; trigger: 'EVENT' | 'NIGHTLY'; signal: AbortSignal; log: JobContext['log'] },
) {
  try {
    const result = await generatePortalFeeds(agencyId, {
      connectionIds: opts.connectionId ? [opts.connectionId] : undefined,
      trigger: opts.trigger,
      signal: opts.signal,
      log: opts.log,
    });
    if (result.push.length > 0) {
      // S9-04: the push portals of the pass, sent by their own job (own retries and budget, same agency group).
      if (opts.trigger === 'NIGHTLY') {
        await withSystem('exports.nightly push mark', (tx) => repo.markNightly(tx, agencyId, result.push, clock.now()));
      }
      await queueAgencyPortalPush(agencyId, opts.connectionId ? [opts.connectionId] : undefined, {
        retryStopped: opts.trigger === 'NIGHTLY',
      });
    }
    return {
      skipped: result.skipped,
      push: result.push.length,
      written: result.written.length,
      unchanged: result.unchanged.length,
      failed: result.failed.length,
      skippedConnections: result.skippedConnections.length,
    };
  } catch (err) {
    if (err instanceof PortalFeedError) throw new UnrecoverableError(err.message);
    throw err;
  }
}

export const exportsJobs = {
  /**
   * Event passes (listing, selection and connection changes): throttled per agency or connection; the heavy jobs'
   * shared caps (`maxConcurrentRuns` across the pool, `runsPerProcess` per process).
   */
  generatePortalFeeds: defineJob({
    name: 'exports.generatePortalFeeds',
    pool: 'exports',
    payload: generatePayload,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    capGroup: websiteApi.EXPORTS_FEED_CAP_GROUP,
    perProcessConcurrency: () => jobsConfig.runsPerProcess,
    globalConcurrency: () => jobsConfig.maxConcurrentRuns,
    attempts: PORTAL_FEED_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: PORTAL_FEED_TIMEOUT_MS,
    run: (p, { log, signal }) => pass(p.agencyId, { connectionId: p.connectionId, trigger: 'EVENT', signal, log }),
  }),

  /**
   * S9-04: sends an agency's push-portal connections (idealista, Fotocasa) what changed, or takes their adverts down
   * (connection off, flag off, agency unverified) - see `push/engine.ts`. Same pool and cap group as the feed passes,
   * so the pool's memory and database load are one budget. S9 review: its own group per agency (`<agency>:push`,
   * `concurrencyPerGroup` 1): an agency's push runs never overlap (nor runs of one connection), but a run's minutes of
   * portal calls do not hold the lease the agency's feed passes and site feeds wait on. Push and feed passes write
   * disjoint state (a pass writes no run, issue or summary for a push connection; push owns the sync rows, issues,
   * summary and `push_error`). Queued by the feed passes (events, nightly) and the agency status subscriber. A run
   * that ran out of calls or time queues its own continuation (with the cursor, and the portal's `Retry-After` if it
   * asked for one); `retry` (the nightly pass) tries connections that stopped on a standing problem again.
   */
  pushPortalListings: defineJob({
    name: 'exports.pushPortalListings',
    pool: 'exports',
    payload: z.object({
      agencyId: z.uuid(),
      connectionId: z.uuid().optional(),
      /** A continuation: the selection round to resume at (needs `connectionId`). */
      cursor: z.uuid().optional(),
      retry: z.boolean().optional(),
    }),
    group: (p) => `${p.agencyId}:push`,
    concurrencyPerGroup: 1,
    capGroup: websiteApi.EXPORTS_FEED_CAP_GROUP,
    perProcessConcurrency: () => jobsConfig.runsPerProcess,
    globalConcurrency: () => jobsConfig.maxConcurrentRuns,
    attempts: PORTAL_FEED_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: PORTAL_FEED_TIMEOUT_MS,
    async run(p, { log, signal }) {
      const result = await pushPortalListings(p.agencyId, {
        connectionIds: p.connectionId ? [p.connectionId] : undefined,
        cursor: p.connectionId ? p.cursor : undefined,
        retryStopped: p.retry,
        signal,
        log,
      });
      // A connection that ran out of calls or time (or was told to wait) continues from where it was.
      for (const c of result.connections) {
        if (!c.more) continue;
        await queuePushContinuation(p.agencyId, c.connectionId, c.resume, c.retryAfterMs);
      }
      return {
        skipped: result.skipped,
        connections: result.connections.length,
        published: result.connections.reduce((n, c) => n + c.published, 0),
        updated: result.connections.reduce((n, c) => n + c.updated, 0),
        withdrawn: result.connections.reduce((n, c) => n + c.withdrawn, 0),
        failed: result.connections.reduce((n, c) => n + c.failed, 0),
        stopped: result.connections.filter((c) => c.stopped).length,
        more: result.connections.filter((c) => c.more).length,
      };
    },
  }),

  /**
   * The nightly lanes' passes: one per agency and night (stable id), each enqueueing its lane's next agency. The lanes
   * bound them (`nightlyLanes` < `maxConcurrentRuns`). Same group as the event passes (`concurrencyPerGroup` 1 on the
   * agency's group lease, which the pool shares): a nightly and an event pass of one agency never overlap. S9 review:
   * the heavy jobs' shared caps, like the event passes; the pass hands its cap slots back before it enqueues the lane's
   * successor, which can then start at once in the same slot.
   */
  generateNightlyPortalFeeds: defineJob({
    name: 'exports.generateNightlyPortalFeeds',
    pool: 'exports',
    payload: nightlyPayload,
    jobId: (p) => `${p.agencyId}:${p.nightly}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    capGroup: websiteApi.EXPORTS_FEED_CAP_GROUP,
    perProcessConcurrency: () => jobsConfig.runsPerProcess,
    globalConcurrency: () => jobsConfig.maxConcurrentRuns,
    attempts: PORTAL_FEED_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: PORTAL_FEED_TIMEOUT_MS,
    async run(p, { log, signal, attempt, releaseCapSlots }) {
      try {
        const result = await pass(p.agencyId, { trigger: 'NIGHTLY', signal, log });
        // The pass is done (its buffers with it): the successor may take this slot at once.
        await releaseCapSlots?.();
        await continueLane(p);
        return result;
      } catch (err) {
        // The lane goes on past an agency that failed for good; a retry continues it later.
        if (err instanceof UnrecoverableError || attempt >= PORTAL_FEED_ATTEMPTS) {
          await releaseCapSlots?.();
          await continueLane(p);
        }
        throw err;
      }
    },
  }),

  sweepNightlyPortalFeeds: defineJob({
    name: 'exports.sweepNightlyPortalFeeds',
    pool: 'exports',
    payload: z.object({}),
    every: 15 * 60_000,
    attempts: 1,
    timeoutMs: 60_000,
    async run(_p, { log }) {
      const seeded = await seedNightlyLanes(clock.now());
      if (seeded > 0) log.info({ lanes: seeded }, 'nightly portal feed lanes seeded');
      return { seeded };
    },
  }),
};

/** A nightly job's lane: the next agency of the lane still due tonight, if any (stable id: a duplicate is a no-op). */
async function continueLane(p: NightlyPayload): Promise<void> {
  const { nightly, lane, lanes } = p;
  const next = await withSystem('exports.nightly lane', (tx) =>
    repo.nextNightlyAgency(tx, { before: windowStartOf(nightly), lanes, lane, after: p.agencyId }),
  );
  if (next) await exportsJobs.generateNightlyPortalFeeds.enqueue({ agencyId: next, nightly, lane, lanes });
}

/**
 * Seeds (or repairs) tonight's lanes inside the window (outside it: none): the first agency of each lane still due,
 * one statement and one bulk add. Returns the lanes seeded.
 */
export async function seedNightlyLanes(now: Date): Promise<number> {
  const window = nightlyWindow(now, jobsConfig.nightlyHourUtc);
  if (!window.open) return 0;
  const lanes = jobsConfig.nightlyLanes;
  const first = await withSystem('exports.sweepNightlyPortalFeeds', (tx) =>
    repo.firstNightlyAgencies(tx, { before: window.start, lanes }),
  );
  if (first.length > 0) {
    await exportsJobs.generateNightlyPortalFeeds.enqueueMany(
      first.map((f) => ({ payload: { agencyId: f.agencyId, nightly: window.day, lane: f.lane, lanes } })),
    );
  }
  return first.length;
}

/** A pass over every live connection of the agency, at most one per throttle window (listing changes). */
export async function queueAgencyPortalFeeds(agencyId: string, throttleMs = PORTAL_FEED_THROTTLE_MS): Promise<void> {
  await exportsJobs.generatePortalFeeds.enqueue({ agencyId }, { throttleMs, debounceKey: `portal-feeds:${agencyId}` });
}

/** A run of one connection, at most one per throttle window per connection (its own changes). */
export async function queueConnectionPortalFeed(
  agencyId: string,
  connectionId: string,
  throttleMs = PORTAL_FEED_CONNECTION_THROTTLE_MS,
): Promise<void> {
  await exportsJobs.generatePortalFeeds.enqueue(
    { agencyId, connectionId },
    { throttleMs, debounceKey: `portal-feed:${connectionId}` },
  );
}

/** A push run for the agency (or one connection), at most one per throttle window. */
export async function queueAgencyPortalPush(
  agencyId: string,
  connectionIds?: readonly string[],
  opts: { throttleMs?: number; retryStopped?: boolean } = {},
): Promise<void> {
  const only = connectionIds?.length === 1 ? connectionIds[0] : undefined;
  await exportsJobs.pushPortalListings.enqueue(
    { agencyId, ...(only ? { connectionId: only } : {}), ...(opts.retryStopped ? { retry: true } : {}) },
    { throttleMs: opts.throttleMs ?? PORTAL_PUSH_THROTTLE_MS, debounceKey: `portal-push:${only ?? agencyId}` },
  );
}

/** The rest of a connection's push run: after `PORTAL_PUSH_CONTINUE_MS`, or the portal's `Retry-After` if longer. */
export async function queuePushContinuation(
  agencyId: string,
  connectionId: string,
  cursor: string | null | undefined,
  retryAfterMs?: number,
): Promise<void> {
  await exportsJobs.pushPortalListings.enqueue(
    { agencyId, connectionId, ...(cursor ? { cursor } : {}) },
    {
      throttleMs: Math.max(retryAfterMs ?? 0, PORTAL_PUSH_CONTINUE_MS),
      debounceKey: `portal-push-more:${connectionId}`,
    },
  );
}
