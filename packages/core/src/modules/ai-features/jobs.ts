import { ListingStudioTone } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as agencies from '../agencies';
import {
  abandonListingStudioBatch,
  collectListingStudioBulk,
  generateListingStudio,
  pruneListingStudioBatches,
  type StudioRequest,
  submitListingStudioBulk,
} from './studio';
import { sanitizeTargetTexts, whiteLabelBackfillPage } from './white-label';

/** The provider's batch answers within 24 h; polled every 2 minutes, given up after a day. */
export const STUDIO_POLL_MS = 2 * 60_000;
export const STUDIO_MAX_POLLS = 720;
/** Batch records are kept this long after they were created (a batch ends within a day). */
export const STUDIO_BATCH_RETENTION_DAYS = 14;
const PRUNE_BATCH = 1_000;

const studioRequest = {
  requestId: z.uuid(),
  agencyId: z.uuid(),
  userId: z.uuid(),
  listingIds: z.array(z.uuid()).min(1).max(100),
  tone: ListingStudioTone,
  locales: z.array(z.string()).min(1).max(20),
  replaceReviewed: z.boolean(),
};

const isPermanent = (err: unknown) =>
  isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'AI_BUDGET_EXCEEDED');

/** A member who left, an agency suspended, the budget's hard cap: retrying cannot help. */
function stopIfPermanent(err: unknown): never {
  if (isPermanent(err)) throw new UnrecoverableError((err as { code: string }).code);
  throw err;
}

/**
 * A bulk job that stops for good marks its batch record GAVE_UP on a system transaction (the member may have lost
 * access, so their own context is refused), so it no longer counts against the agency's running batches.
 */
async function abandonIfPermanent(err: unknown, p: { agencyId: string; requestId: string }): Promise<never> {
  if (isPermanent(err)) {
    await withSystem('aiFeatures.abandonListingStudioBatch', (tx) =>
      abandonListingStudioBatch(tx, p.agencyId, p.requestId),
    );
  }
  stopIfPermanent(err);
}

const asRequest = (p: z.output<z.ZodObject<typeof studioRequest>>): StudioRequest => ({
  requestId: p.requestId,
  agencyId: p.agencyId,
  userId: p.userId,
  listingIds: p.listingIds,
  tone: p.tone,
  locales: p.locales,
  replaceReviewed: p.replaceReviewed,
});

/**
 * ai-features worker jobs (PATTERNS §12). Idempotent: a re-run gets the same answers from the AI cache (no second
 * provider call) and rewrites only the unlocked targets; fair share per agency.
 *
 * - `aiFeatures.generateListingCopy` (S12-02, pool `ai`; one per `aiFeatures.listingStudio.requested` SINGLE event,
 *   job ID = the request id): one listing's drafts, one structured FAST call per target locale (`studio.ts`). An AI
 *   outage is retried with backoff; the budget's hard cap or a member who lost access stops it.
 * - `aiFeatures.submitListingStudioBatch` (S12-02, pool `ai`; BULK events): one batch for up to 100 listings × the
 *   requested locales, recorded in `listing_studio_batches`; answers the cache had are written at once; then the
 *   first `collectListingStudioBatch` is queued.
 * - `aiFeatures.collectListingStudioBatch` (pool `ai`): polls the provider's batch every `STUDIO_POLL_MS` (a new
 *   delayed job per poll, job ID = request id + poll number) up to `STUDIO_MAX_POLLS`, then writes the checked
 *   drafts (or marks the record GAVE_UP).
 * - `aiFeatures.pruneListingStudioBatches` (daily, pool `maintenance`, all agencies via `withSystem`): deletes batch
 *   records older than `STUDIO_BATCH_RETENTION_DAYS`, `PRUNE_BATCH` per statement until a short one.
 */
export const aiFeaturesJobs = {
  generateListingCopy: defineJob({
    name: 'aiFeatures.generateListingCopy',
    pool: 'ai',
    payload: z.object(studioRequest),
    jobId: (p) => p.requestId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 2,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 5 * 60_000,
    async run(p, job) {
      try {
        const outcome = await generateListingStudio(asRequest(p), job.log);
        return { written: Object.keys(outcome.written).length, dropped: Object.keys(outcome.dropped).length };
      } catch (err) {
        stopIfPermanent(err);
      }
    },
  }),

  submitListingStudioBatch: defineJob({
    name: 'aiFeatures.submitListingStudioBatch',
    pool: 'ai',
    payload: z.object(studioRequest),
    jobId: (p) => p.requestId,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 10 * 60_000,
    async run(p, job) {
      try {
        const res = await submitListingStudioBulk(asRequest(p));
        if (res.status === 'SUBMITTED') {
          await aiFeaturesJobs.collectListingStudioBatch.enqueue(
            { requestId: p.requestId, agencyId: p.agencyId, userId: p.userId, poll: 1 },
            { delayMs: STUDIO_POLL_MS },
          );
        }
        job.log.info({ requestId: p.requestId, status: res.status }, 'listing studio batch submitted');
        return { status: res.status };
      } catch (err) {
        return await abandonIfPermanent(err, p);
      }
    },
  }),

  collectListingStudioBatch: defineJob({
    name: 'aiFeatures.collectListingStudioBatch',
    pool: 'ai',
    payload: z.object({ requestId: z.uuid(), agencyId: z.uuid(), userId: z.uuid(), poll: z.number().int().min(1) }),
    jobId: (p) => `${p.requestId}.${p.poll}`,
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 10 * 60_000,
    async run(p, job) {
      try {
        const who = { requestId: p.requestId, agencyId: p.agencyId, userId: p.userId };
        const res = await collectListingStudioBulk(who, { giveUp: p.poll > STUDIO_MAX_POLLS });
        if (res.status === 'IN_PROGRESS') {
          await aiFeaturesJobs.collectListingStudioBatch.enqueue(
            { ...p, poll: p.poll + 1 },
            { delayMs: STUDIO_POLL_MS },
          );
          return { status: 'IN_PROGRESS' };
        }
        job.log.info(
          { requestId: p.requestId, written: Object.keys(res.outcome.written).length },
          'listing studio batch applied',
        );
        return { status: 'DONE' };
      } catch (err) {
        return await abandonIfPermanent(err, p);
      }
    },
  }),

  pruneListingStudioBatches: defineJob({
    name: 'aiFeatures.pruneListingStudioBatches',
    pool: 'maintenance',
    payload: z.object({}),
    every: 24 * 3_600_000,
    async run(_p, job) {
      const before = new Date(clock.now().getTime() - STUDIO_BATCH_RETENTION_DAYS * 86_400_000);
      let deleted = 0;
      for (;;) {
        const n = await withSystem('aiFeatures.pruneListingStudioBatches', (tx) =>
          pruneListingStudioBatches(tx, before, PRUNE_BATCH),
        );
        deleted += n;
        if (n < PRUNE_BATCH || job.signal.aborted) break;
      }
      return { deleted };
    },
  }),
};

/**
 * S13-F7: how often the white-label backfill sweeps every agency's network-shown documents — well inside the cached
 * removals' lifetime (`AI_REMOVALS_TTL_SECONDS`, 60 days), so an answered entry is rewritten before it expires.
 */
export const WHITE_LABEL_SWEEP_EVERY_MS = 30 * 86_400_000;
/**
 * S13-F7: when a degraded `sanitizeTexts` run (budget, outage) asks again for its degraded targets: 15 minutes, 1 hour,
 * 4 hours, 12 hours after the previous run; then the backfill sweep.
 */
export const DEGRADED_RETRY_DELAYS_MS: readonly number[] = [15 * 60_000, 3_600_000, 4 * 3_600_000, 12 * 3_600_000];
/** Agencies read per statement by the sweep. */
const SWEEP_AGENCY_PAGE = 500;
/** A sweep's run id (its UTC day): part of its jobs' ids, so a re-run sweep of the same day queues nothing twice. */
const RUN_RE = /^\d{4}-\d{2}-\d{2}$/;
const backfillCursor = z.object({ kind: z.enum(['LISTING', 'UNIT']), targetId: z.uuid() });

/** S13-F6: the white-label sanitizer's fair-share group, apart from the agency's interactive `ai` jobs. */
export const whiteLabelGroup = (agencyId: string): string => `wl:${agencyId}`;

/**
 * The white-label sanitizer's model pass as a job (S12-03, PATTERNS §12, pool `ai`): one owner agency's changed
 * documents (≤ `search.PUBLIC_DOCS_EVENT_TARGETS` targets, every locale), queued by `search.publicDocs.changed`.
 * Idempotent (job ID = the event's id, so a redelivered event is one job; answered texts are skipped; the gateway
 * caches by input hash), per-tenant fair share, one at a time per agency so a bulk import cannot take the pool.
 *
 * S13-F6: its fair-share group is `wl:<agency>` (`whiteLabelGroup`), not the agency's own group. Fair share is per
 * (pool, group) backlog depth, so ~50 sanitize jobs queued by an import used to put the agency's next interactive `ai`
 * job (Listing Studio, captions) at priority 51 behind all of them, and took one of its `concurrencyPerGroup` slots.
 * In its own group the bulk backlog no longer counts: an interactive job keeps the agency group at priority 1.
 *
 * S13-F7: `search.publicDocs.changed` queues it for the event's `networkShownIds` only (none: no job), so a price edit
 * or a full rebuild that rewrites rows with the same text costs nothing. Documents shown before the pass existed (or
 * whose pass degraded) get it from the backfill:
 * - `aiFeatures.whiteLabelSweep` (pool `maintenance`, every `WHITE_LABEL_SWEEP_EVERY_MS`, stable job ids per run day):
 *   queues one `whiteLabelBackfill` per agency (agency id pages of `SWEEP_AGENCY_PAGE`).
 * - `aiFeatures.whiteLabelBackfill` (pool `ai`, group `wl:<agency>`, one at a time per agency): one page of
 *   `BACKFILL_PAGE_TARGETS` network-shown targets (`whiteLabelBackfillPage`), then queues the next page (job id = run,
 *   agency and cursor: resumable, a re-run collapses). Answered targets and cached answers cost no model call; a
 *   degraded page (budget, outage) stops the agency's walk until the next sweep.
 */
export const whiteLabelJobs = {
  sanitizeTexts: defineJob({
    name: 'aiFeatures.sanitizeTexts',
    pool: 'ai',
    payload: z.object({
      /** The `search.publicDocs.changed` event: one job per event, a redelivered event collapses into it. */
      eventId: z.uuid(),
      agencyId: z.uuid(),
      targetIds: z.array(z.uuid()).min(1).max(100),
      /** S13-F7: the how-manieth later run for targets a degraded run left deterministic-only (0: the event's run). */
      retry: z.number().int().min(0).max(DEGRADED_RETRY_DELAYS_MS.length).default(0),
    }),
    jobId: (p) => (p.retry > 0 ? `${p.eventId}.r${p.retry}` : p.eventId),
    group: (p) => whiteLabelGroup(p.agencyId),
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 5 * 60_000,
    async run(p, { log, jobId }) {
      const degradedCodes = new Set<string>();
      const result = await sanitizeTargetTexts(
        { agencyId: p.agencyId, targetIds: p.targetIds },
        { requestId: jobId, onDegrade: (code) => degradedCodes.add(code) },
      );
      if (result.degraded > 0) {
        // S13-F7: the event will not come again for unchanged text — ask again later for the degraded targets (the
        // budget or the provider may be back), a bounded number of times; after that the backfill sweep covers them.
        const delayMs = DEGRADED_RETRY_DELAYS_MS[p.retry];
        if (delayMs !== undefined) {
          await whiteLabelJobs.sanitizeTexts.enqueue(
            { eventId: p.eventId, agencyId: p.agencyId, targetIds: result.degradedTargetIds, retry: p.retry + 1 },
            { delayMs },
          );
        }
        log.warn(
          { ...result, codes: [...degradedCodes], retryInMs: delayMs ?? null },
          'white-label model pass degraded: deterministic only',
        );
      }
      return result;
    },
  }),

  whiteLabelSweep: defineJob({
    name: 'aiFeatures.whiteLabelSweep',
    pool: 'maintenance',
    payload: z.object({}),
    every: WHITE_LABEL_SWEEP_EVERY_MS,
    timeoutMs: 10 * 60_000,
    async run(_p, job) {
      const run = clock.now().toISOString().slice(0, 10);
      let after: string | null = null;
      let queued = 0;
      for (;;) {
        const ids = await withSystem('aiFeatures.whiteLabelSweep', (tx) =>
          agencies.agencyIdsPage(tx, after, SWEEP_AGENCY_PAGE),
        );
        for (const agencyId of ids) await whiteLabelJobs.whiteLabelBackfill.enqueue({ run, agencyId, after: null });
        queued += ids.length;
        after = ids.at(-1) ?? null;
        if (ids.length < SWEEP_AGENCY_PAGE || job.signal.aborted) break;
      }
      return { run, queued };
    },
  }),

  whiteLabelBackfill: defineJob({
    name: 'aiFeatures.whiteLabelBackfill',
    pool: 'ai',
    payload: z.object({ run: z.string().regex(RUN_RE), agencyId: z.uuid(), after: backfillCursor.nullable() }),
    jobId: (p) => `wlb.${p.run}.${p.agencyId}.${p.after?.targetId ?? 'start'}`,
    group: (p) => whiteLabelGroup(p.agencyId),
    concurrencyPerGroup: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log, jobId }) {
      const degradedCodes = new Set<string>();
      const result = await whiteLabelBackfillPage(
        { agencyId: p.agencyId, after: p.after },
        { requestId: jobId, onDegrade: (code) => degradedCodes.add(code) },
      );
      if (result.degraded > 0) {
        // Over budget or the model unavailable: the agency's walk stops here; events and the next sweep carry on.
        log.warn({ ...result, codes: [...degradedCodes] }, 'white-label backfill degraded: walk stopped');
        return { ...result, stopped: true };
      }
      if (result.next) {
        await whiteLabelJobs.whiteLabelBackfill.enqueue({ run: p.run, agencyId: p.agencyId, after: result.next });
      }
      return result;
    },
  }),
};
