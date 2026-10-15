import { withTenant } from '@inmolink/db';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { recomputeListingQuality } from './service';

/** Bursts of changes to one listing (autosave, a batch of photos) collapse into one recompute this long after the last. */
export const QUALITY_DEBOUNCE_MS = 2_000;
/** Photos still processing: look again this long later, at most this many times (their size is not an event). */
const PENDING_RECHECK_MS = 60_000;
export const QUALITY_PENDING_RECHECKS = 10;

const payload = z.object({
  listingId: z.uuid(),
  agencyId: z.uuid(),
  /** How many times this recompute was queued again for photos still processing. */
  recheck: z.number().int().min(0).max(QUALITY_PENDING_RECHECKS).default(0),
});

/**
 * quality worker jobs (PATTERNS §12). Idempotent, per-tenant fair share.
 *
 * `quality.recomputeListing` (pool `indexing`; from listing and media events, debounced per listing): recomputes
 * the listing's score in the owner agency's tenant transaction (RLS on) and stores it when it changed. While
 * photos are still processing their resolution is not known yet, so the job queues itself again a minute later
 * (≤ `QUALITY_PENDING_RECHECKS` times).
 */
export const qualityJobs = {
  recomputeListing: defineJob({
    name: 'quality.recomputeListing',
    pool: 'indexing',
    payload,
    group: (p) => p.agencyId,
    attempts: 5,
    timeoutMs: 60_000,
    async run(p, { log }) {
      const result = await withTenant({ agencyId: p.agencyId }, (tx) =>
        recomputeListingQuality(tx, p.agencyId, p.listingId),
      );
      if (!result) return { gone: true };
      if (result.pendingPhotos > 0 && p.recheck < QUALITY_PENDING_RECHECKS) {
        await enqueueRecompute(p.listingId, p.agencyId, { recheck: p.recheck + 1, debounceMs: PENDING_RECHECK_MS });
      }
      if (result.changed) log.debug({ listingId: p.listingId, score: result.score }, 'listing quality stored');
      return result;
    },
  }),
};

/** Queues a (debounced) recompute of one listing's score. Network I/O (the queue): never inside a transaction. */
export async function enqueueRecompute(
  listingId: string,
  agencyId: string,
  options: { recheck?: number; debounceMs?: number } = {},
): Promise<void> {
  await qualityJobs.recomputeListing.enqueue(
    { listingId, agencyId, recheck: options.recheck ?? 0 },
    // A recheck has its own key: it must never replace (and delay) the recompute an edit queued.
    {
      debounceMs: options.debounceMs ?? QUALITY_DEBOUNCE_MS,
      debounceKey: options.recheck ? `${listingId}.recheck` : listingId,
    },
  );
}
