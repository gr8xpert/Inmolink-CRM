import { ListingStudioTone } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import {
  abandonListingStudioBatch,
  collectListingStudioBulk,
  generateListingStudio,
  pruneListingStudioBatches,
  type StudioRequest,
  submitListingStudioBulk,
} from './studio';
import { sanitizeTargetTexts } from './white-label';

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
 * The white-label sanitizer's model pass as a job (S12-03, PATTERNS §12, pool `ai`): one owner agency's changed
 * documents (≤ `search.PUBLIC_DOCS_EVENT_TARGETS` targets, every locale), queued by `search.publicDocs.changed`.
 * Idempotent (job ID = the event's id, so a redelivered event is one job; answered texts are skipped; the gateway
 * caches by input hash), per-tenant fair share, one at a time per agency so a bulk import cannot take the pool.
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
    }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
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
        log.warn({ ...result, codes: [...degradedCodes] }, 'white-label model pass degraded: deterministic only');
      }
      return result;
    },
  }),
};
