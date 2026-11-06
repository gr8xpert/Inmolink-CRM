import { DEFAULT_AGENCY_TIME_ZONE } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as agencies from '../agencies';
import * as crm from '../crm';
import * as search from '../search';
import { DELIVERY_LIMITS, type DeliveryPeriod, deliverProfile, digestPeriodsDue, digestProfilesPage } from './delivery';
import { backfillListingFacts, matchListingsToProfiles, matchProfilesToListings, profileMatchWindow } from './engine';
import { CLIENT_PROFILE_EVENT_IDS } from './events';
import { recordDismissalFeedback, recordSelectionFeedback } from './feedback';
import { embedProfiles, profileBackfillPage } from './profile-embeddings';
import { eraseContactProfiles, repointClientProfiles } from './profiles';
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

/** Once a day: profiles an event missed (embeddings off, over budget, an outage) or whose text changed without one. */
export const PROFILE_EMBEDDINGS_SWEEP_EVERY_MS = 24 * 3_600_000;
const PROFILE_SWEEP_AGENCY_PAGE = 500;
/** Job ids of a profile backfill page: run, agency and cursor (a re-run of the same page collapses). */
export const profileBackfillKey = (p: { run: string; agencyId: string; after: string | null }): string =>
  `pemb.${p.run}.${p.agencyId}.${p.after ?? 'start'}`;

/**
 * Client-profile embedding jobs (R2-01b, `profile-embeddings.ts`), pool `ai` (model calls; the agency's embedding
 * group `emb:<agency>`, shared with its listing embeddings) and `maintenance` (the sweep):
 *
 * - `matching.embedProfiles` (`matching.clientProfiles.changed`; job id = the event's id): embeds that event's profiles
 *   whose text changed, drops the vectors of deleted or `OFF` ones. Degraded: logged, left to the sweep.
 * - `matching.profileEmbeddingsSweep` (schedule: every `PROFILE_EMBEDDINGS_SWEEP_EVERY_MS`, job ids per run day):
 *   queues one backfill walk per agency. Nothing while embeddings are off.
 * - `matching.profileEmbeddingsBackfill` (one at a time per agency): one window of profiles, then the next page; a
 *   degraded page ends the agency's walk until the next sweep.
 */
export const profileEmbeddingJobs = {
  embedProfiles: defineJob({
    name: 'matching.embedProfiles',
    pool: 'ai',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      profileIds: z.array(z.uuid()).min(1).max(CLIENT_PROFILE_EVENT_IDS),
    }),
    jobId: (p) => `pemb.${p.eventId}`,
    group: (p) => search.embeddingGroup(p.agencyId),
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 5 * 60_000,
    async run(p, { log, jobId }) {
      const result = await embedProfiles({ agencyId: p.agencyId, profileIds: p.profileIds }, { requestId: jobId });
      if (result.degraded > 0) log.warn(result, 'client-profile embeddings degraded: left to the sweep');
      return result;
    },
  }),

  profileEmbeddingsSweep: defineJob({
    name: 'matching.profileEmbeddingsSweep',
    pool: 'maintenance',
    payload: z.object({}),
    every: PROFILE_EMBEDDINGS_SWEEP_EVERY_MS,
    timeoutMs: 10 * 60_000,
    async run(_p, job) {
      if (search.embeddingModel() === null) return { run: null, queued: 0 };
      const run = clock.now().toISOString().slice(0, 10);
      let after: string | null = null;
      let queued = 0;
      for (;;) {
        const ids: string[] = await withSystem('matching.profileEmbeddingsSweep', (tx) =>
          agencies.agencyIdsPage(tx, after, PROFILE_SWEEP_AGENCY_PAGE),
        );
        if (ids.length > 0) {
          await profileEmbeddingJobs.profileEmbeddingsBackfill.enqueueMany(
            ids.map((agencyId) => ({ payload: { run, agencyId, after: null } })),
          );
        }
        queued += ids.length;
        after = ids.at(-1) ?? null;
        if (ids.length < PROFILE_SWEEP_AGENCY_PAGE || job.signal.aborted) break;
      }
      return { run, queued };
    },
  }),

  profileEmbeddingsBackfill: defineJob({
    name: 'matching.profileEmbeddingsBackfill',
    pool: 'ai',
    payload: z.object({
      run: z.string().regex(/^[0-9A-Za-z-]{1,32}$/),
      agencyId: z.uuid(),
      after: z.uuid().nullable(),
    }),
    jobId: profileBackfillKey,
    group: (p) => search.embeddingGroup(p.agencyId),
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log }) {
      const key = profileBackfillKey(p);
      const result = await profileBackfillPage({ agencyId: p.agencyId, after: p.after }, { requestId: key });
      if (result.degraded > 0) log.warn(result, 'client-profile embedding backfill degraded: walk stopped');
      if (result.next) {
        await profileEmbeddingJobs.profileEmbeddingsBackfill.enqueue({
          run: p.run,
          agencyId: p.agencyId,
          after: result.next,
        });
      }
      return result;
    },
  }),
};

/**
 * R2-02a: client profiles follow their contact (pool `maintenance`, like the other modules' merge / erasure reactions;
 * group = the agency; job ID = the event's id: a redelivered event adds nothing).
 *
 * - `matching.repointClientProfiles` — one per `crm.contact.merged`: the closed contact's profiles name the survivor
 *   (each batch emits `matching.clientProfiles.changed`). Idempotent.
 * - `matching.eraseContactProfiles` — one per `crm.contact.erased`: the profiles of the erased contact and of the
 *   contacts merged into it are deleted with their vectors. Idempotent.
 */
export const clientProfileJobs = {
  repointClientProfiles: defineJob({
    name: 'matching.repointClientProfiles',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), survivorId: z.uuid(), mergedId: z.uuid() }),
    jobId: (p) => `profiles-merge:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      return repointClientProfiles(p);
    },
  }),

  eraseContactProfiles: defineJob({
    name: 'matching.eraseContactProfiles',
    pool: 'maintenance',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), contactId: z.uuid() }),
    jobId: (p) => `profiles-erase:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p) {
      const contactIds = await crm.erasedContactIds({ agencyId: p.agencyId, contactIds: [p.contactId] });
      return eraseContactProfiles({ agencyId: p.agencyId, contactIds });
    },
  }),
};

/**
 * R2-02c, the learned boost's feedback (`feedback.ts`), pool `matching`, group = the agency, job id from the event (a
 * redelivered event adds nothing; a re-run reads the current state and changes nothing twice):
 *
 * - `matching.selectionFeedback` — one per `presentations.selection.interacted` like / unlike: the client's current
 *   like of the item on the profiles of the selection's contact.
 * - `matching.dismissalFeedback` — one per `matching.clientProfileMatch.dismissed`: the listing turned down.
 */
export const feedbackJobs = {
  selectionFeedback: defineJob({
    name: 'matching.selectionFeedback',
    pool: 'matching',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), selectionId: z.uuid(), targetId: z.uuid() }),
    jobId: (p) => `pfb-s:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return recordSelectionFeedback(p);
    },
  }),

  dismissalFeedback: defineJob({
    name: 'matching.dismissalFeedback',
    pool: 'matching',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), matchId: z.uuid() }),
    jobId: (p) => `pfb-d:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p) {
      return recordDismissalFeedback(p);
    },
  }),
};

/** Once a day: every agency's active profiles against the live listings (what events missed, new stock in reach). */
export const PROFILE_MATCH_SWEEP_EVERY_MS = 24 * 3_600_000;
const MATCH_SWEEP_AGENCY_PAGE = 500;
/** Job ids of a match sweep window: run, agency and cursor (a re-run of the same window collapses). */
export const matchWindowKey = (p: { run: string; agencyId: string; after: string | null }): string =>
  `pmatch-w.${p.run}.${p.agencyId}.${p.after ?? 'start'}`;

/**
 * R2-02b, the match engine's jobs (`engine.ts`), pool `matching`, group = the agency (fair share):
 *
 * - `matching.matchListingsToProfiles` — one per `search.listings.changed` event (job id from the event): the listings'
 *   facts, then the profiles of any agency that may see them.
 * - `matching.matchProfilesToListings` — one per `matching.clientProfiles.changed` event (job id from the event): those
 *   profiles against the live listings.
 * - `matching.profileMatchSweep` (every `PROFILE_MATCH_SWEEP_EVERY_MS`, pool `maintenance`): one window walk per agency,
 *   spread over `SWEEP_SPREAD_MS`.
 * - `matching.profileMatchWindow` — `MATCH_SWEEP_WINDOW` profiles of an agency, then the next window (one at a time
 *   per agency).
 * - `matching.backfillListingFacts` — queued once after deploy (`{ after: null }`): the facts of existing listings.
 *
 * Idempotent: a retried or redelivered job writes no pair twice (`client_profile_matches_pair_uq`).
 */
export const clientMatchJobs = {
  matchListingsToProfiles: defineJob({
    name: 'matching.matchListingsToProfiles',
    pool: 'matching',
    payload: z.object({ eventId: z.uuid(), agencyId: z.uuid(), listingIds: z.array(z.uuid()).min(1).max(100) }),
    jobId: (p) => `pmatch-l:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const r = await matchListingsToProfiles(p);
      await queueInstantDeliveries(r.queued);
      if (r.matched > 0) log.info({ candidates: r.candidates, matched: r.matched }, 'client profile matches written');
      return { candidates: r.candidates, matched: r.matched };
    },
  }),

  matchProfilesToListings: defineJob({
    name: 'matching.matchProfilesToListings',
    pool: 'matching',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      profileIds: z.array(z.uuid()).min(1).max(CLIENT_PROFILE_EVENT_IDS),
    }),
    jobId: (p) => `pmatch-p:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p) {
      const r = await matchProfilesToListings(p);
      await queueInstantDeliveries(r.queued);
      return { candidates: r.candidates, matched: r.matched };
    },
  }),

  profileMatchSweep: defineJob({
    name: 'matching.profileMatchSweep',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: PROFILE_MATCH_SWEEP_EVERY_MS,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const run = clock.now().toISOString().slice(0, 10);
      let after: string | null = null;
      let queued = 0;
      while (!signal.aborted) {
        const ids: string[] = await withSystem('matching.profileMatchSweep', (tx) =>
          agencies.agencyIdsPage(tx, after, MATCH_SWEEP_AGENCY_PAGE),
        );
        if (ids.length > 0) {
          await clientMatchJobs.profileMatchWindow.enqueueMany(
            ids.map((agencyId) => ({
              payload: { run, agencyId, after: null },
              options: { delayMs: sweepDelayOf(agencyId) },
            })),
          );
        }
        queued += ids.length;
        after = ids.at(-1) ?? null;
        if (ids.length < MATCH_SWEEP_AGENCY_PAGE) break;
      }
      log.info({ run, queued }, 'client profile match sweep queued');
      return { run, queued };
    },
  }),

  profileMatchWindow: defineJob({
    name: 'matching.profileMatchWindow',
    pool: 'matching',
    payload: z.object({
      run: z.string().regex(/^[0-9A-Za-z-]{1,32}$/),
      agencyId: z.uuid(),
      after: z.uuid().nullable(),
    }),
    jobId: matchWindowKey,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 120_000,
    async run(p) {
      const r = await profileMatchWindow({ agencyId: p.agencyId, after: p.after });
      await queueInstantDeliveries(r.queued);
      if (r.next) await clientMatchJobs.profileMatchWindow.enqueue({ run: p.run, agencyId: p.agencyId, after: r.next });
      return { profiles: r.profiles, candidates: r.candidates, matched: r.matched, next: r.next };
    },
  }),

  backfillListingFacts: defineJob({
    name: 'matching.backfillListingFacts',
    pool: 'matching',
    payload: z.object({ after: z.uuid().nullable() }),
    jobId: (p) => `backfill-facts:${p.after ?? 'start'}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 120_000,
    async run(p, { log }) {
      const r = await backfillListingFacts(p.after);
      if (r.next) await clientMatchJobs.backfillListingFacts.enqueue({ after: r.next });
      else log.info('matching listing facts backfilled');
      return r;
    },
  }),
};

const PERIOD = z.union([
  z.literal('INSTANT'),
  z.string().regex(/^D:\d{4}-\d{2}-\d{2}$/),
  z.string().regex(/^W:\d{4}-W\d{2}$/),
]);
const DELIVERY_SWEEP_AGENCY_PAGE = 500;
const LOCAL_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * R2-02e: the INSTANT deliveries of the profiles the engine just queued matches for — one per profile, throttled
 * (`DELIVERY_LIMITS.instantDebounceMs`: the first new match starts the wait, the ones until then ride along). After
 * the engine's commit; a lost enqueue is picked up by the next daily walk (`matching.sweepDeliveries`).
 */
async function queueInstantDeliveries(queued: readonly { agencyId: string; profileId: string }[]): Promise<void> {
  if (queued.length === 0) return;
  await deliveryJobs.deliverProfile.enqueueMany(
    queued.map((q) => ({
      payload: { agencyId: q.agencyId, profileId: q.profileId, period: 'INSTANT' as const },
      options: { throttleMs: DELIVERY_LIMITS.instantDebounceMs },
    })),
  );
}

/**
 * R2-02e, AUTO_SEND delivery (`delivery.ts`), group = the agency (fair share):
 *
 * - `matching.deliverProfile` (pool `email`: it sends, and reads the client's page as `app_public`) — one profile's
 *   delivery for a period (job id per profile and period: a digest is queued once; INSTANT ones are throttled).
 *   Idempotent: a re-run finds the matches sent; a failed e-mail is retried (with a new link) by the job's attempts.
 * - `matching.sweepDeliveries` (every hour): the agencies whose local time is the digest hour or later that day get
 *   their walks — DAILY every day, WEEKLY on the weekly day, and INSTANT ones too (what a lost enqueue left); a missed
 *   hour (deploy, worker down) is caught up later the same day, never twice (job ids, `period_uq`).
 * - `matching.deliverDigests` — one agency's walk for a frequency and period: `DELIVERY_LIMITS.digestPage` profiles
 *   with queued matches a run, one `deliverProfile` each, then the next page.
 */
export const deliveryJobs = {
  deliverProfile: defineJob({
    name: 'matching.deliverProfile',
    pool: 'email',
    payload: z.object({ agencyId: z.uuid(), profileId: z.uuid(), period: PERIOD }),
    jobId: (p) => `pdel:${p.profileId}:${p.period}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const r = await deliverProfile({ ...p, period: p.period as DeliveryPeriod });
      if (r.outcome === 'NOT_CONFIGURED') log.warn('client alerts: PUBLIC_PAGES_URL not configured, nothing sent');
      else if (r.outcome === 'CAPPED') log.warn({ profileId: p.profileId }, 'client alert capped');
      else if (r.outcome === 'SENT' || r.resent)
        log.info({ profileId: p.profileId, channel: r.channel, sent: r.sent, resent: r.resent }, 'client alert sent');
      return { outcome: r.outcome, sent: r.sent, duplicates: r.duplicates, expired: r.expired, resent: r.resent };
    },
  }),

  sweepDeliveries: defineJob({
    name: 'matching.sweepDeliveries',
    pool: 'matching',
    payload: z.object({}).strict(),
    every: 3_600_000,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const now = clock.now();
      let after: string | null = null;
      let queued = 0;
      while (!signal.aborted) {
        const page: { ids: string[]; zones: Map<string, string> } = await withSystem(
          'matching.sweepDeliveries',
          async (tx) => {
            const ids = await agencies.agencyIdsPage(tx, after, DELIVERY_SWEEP_AGENCY_PAGE);
            return { ids, zones: await agencies.agencyTimeZones(tx, ids) };
          },
        );
        const walks = page.ids.flatMap((agencyId) => {
          const due = digestPeriodsDue(now, page.zones.get(agencyId) ?? DEFAULT_AGENCY_TIME_ZONE);
          const daily = due.find((d) => d.frequency === 'DAILY');
          if (!daily) return [];
          const localDay = daily.period.slice(2);
          return [
            ...due.map((d) => ({ agencyId, frequency: d.frequency, period: d.period, day: localDay, after: null })),
            { agencyId, frequency: 'INSTANT' as const, period: 'INSTANT' as const, day: localDay, after: null },
          ];
        });
        if (walks.length > 0) await deliveryJobs.deliverDigests.enqueueMany(walks.map((payload) => ({ payload })));
        queued += walks.length;
        after = page.ids.at(-1) ?? null;
        if (page.ids.length < DELIVERY_SWEEP_AGENCY_PAGE) break;
      }
      if (queued > 0) log.info({ queued }, 'client alert digests queued');
      return { queued };
    },
  }),

  deliverDigests: defineJob({
    name: 'matching.deliverDigests',
    pool: 'matching',
    payload: z.object({
      agencyId: z.uuid(),
      frequency: z.enum(['INSTANT', 'DAILY', 'WEEKLY']),
      period: PERIOD,
      /** The agency's local day the walk is for (one walk per frequency and local day). */
      day: LOCAL_DAY,
      after: z.uuid().nullable(),
    }),
    // one walk per agency, frequency and local day (the hourly sweep queues it again until the day ends: collapsed)
    jobId: (p) => `pdig:${p.agencyId}:${p.frequency}:${p.period}:${p.day}:${p.after ?? 'start'}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 120_000,
    async run(p) {
      const ids = await digestProfilesPage(p.agencyId, p.frequency, p.after, DELIVERY_LIMITS.digestPage);
      if (ids.length > 0) {
        await deliveryJobs.deliverProfile.enqueueMany(
          ids.map((profileId) => ({
            payload: { agencyId: p.agencyId, profileId, period: p.period },
            ...(p.period === 'INSTANT' ? { options: { throttleMs: DELIVERY_LIMITS.instantDebounceMs } } : {}),
          })),
        );
      }
      const next = ids.length < DELIVERY_LIMITS.digestPage ? null : (ids.at(-1) ?? null);
      if (next) await deliveryJobs.deliverDigests.enqueue({ ...p, after: next });
      return { profiles: ids.length, next };
    },
  }),
};
