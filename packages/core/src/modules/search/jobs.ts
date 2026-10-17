import { withSystem } from '@inmolink/db';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import { rebuildAllReadModels, rebuildDevelopmentReadModels, rebuildReadModels } from './service';

/** Bursts of changes to one target (autosave, a batch of photos) collapse into one rebuild this long after the last. */
export const READ_MODEL_DEBOUNCE_MS = 2_000;
/** Images still processing: look again this long later, at most this many times (processing is not an event). */
const PENDING_RECHECK_MS = 60_000;
export const READ_MODEL_PENDING_RECHECKS = 10;

const ReadModelKind = z.enum(['LISTING', 'UNIT']);

/**
 * search worker jobs (PATTERNS §12), pool `indexing`. Idempotent (a rebuild reads current state and never moves a
 * read model backwards), per-tenant fair share (`meta.agencyId`).
 *
 * `search.buildReadModel` (from listing, media and unit events, debounced per target): rebuilds one listing's or
 * unit's documents, or drops them when it has none any more. While images are still processing it queues itself
 * again a minute later (≤ `READ_MODEL_PENDING_RECHECKS` times).
 *
 * `search.buildDevelopmentReadModels` (a development's text, place, access or deletion; debounced): rebuilds the
 * development's units.
 *
 * `search.buildAgencyReadModels` (the agency's content locales changed; debounced): rebuilds all its documents and
 * drops those of removed locales.
 */
export const searchJobs = {
  buildReadModel: defineJob({
    name: 'search.buildReadModel',
    pool: 'indexing',
    payload: z.object({
      kind: ReadModelKind,
      id: z.uuid(),
      agencyId: z.uuid(),
      recheck: z.number().int().min(0).max(READ_MODEL_PENDING_RECHECKS).default(0),
    }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const result = await withSystem('search.buildReadModel', (tx) => rebuildReadModels(tx, p.kind, [p.id]));
      if (result.pendingMedia.length > 0 && p.recheck < READ_MODEL_PENDING_RECHECKS) {
        await enqueueReadModel(p.kind, p.id, p.agencyId, { recheck: p.recheck + 1, debounceMs: PENDING_RECHECK_MS });
      }
      log.debug({ kind: p.kind, id: p.id, ...result }, 'read model built');
      return { built: result.built, written: result.written, deleted: result.deleted };
    },
  }),

  buildDevelopmentReadModels: defineJob({
    name: 'search.buildDevelopmentReadModels',
    pool: 'indexing',
    payload: z.object({ developmentId: z.uuid(), agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 300_000,
    async run(p, { log }) {
      const result = await rebuildDevelopmentReadModels(p.developmentId);
      log.info({ developmentId: p.developmentId, ...result, pendingMedia: undefined }, 'development read models built');
      return { built: result.built, written: result.written, deleted: result.deleted };
    },
  }),

  buildAgencyReadModels: defineJob({
    name: 'search.buildAgencyReadModels',
    pool: 'indexing',
    payload: z.object({ agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 1_800_000,
    async run(p, { log, progress }) {
      const result = await rebuildAllReadModels({
        agencyId: p.agencyId,
        reason: 'search.buildAgencyReadModels',
        onProgress: (r) => void progress({ kind: r.kind, done: r.done }),
      });
      log.info({ agencyId: p.agencyId, result }, 'agency read models built');
      return { listings: result.LISTING.built, units: result.UNIT.built };
    },
  }),
};

/** Queues a (debounced) rebuild of one target. Network I/O (the queue): never inside a transaction. */
export async function enqueueReadModel(
  kind: 'LISTING' | 'UNIT',
  id: string,
  agencyId: string,
  options: { recheck?: number; debounceMs?: number } = {},
): Promise<void> {
  await searchJobs.buildReadModel.enqueue(
    { kind, id, agencyId, recheck: options.recheck ?? 0 },
    // A recheck has its own key: it must never replace (and delay) the rebuild an edit queued.
    {
      debounceMs: options.debounceMs ?? READ_MODEL_DEBOUNCE_MS,
      debounceKey: options.recheck ? `${id}.recheck` : id,
    },
  );
}
