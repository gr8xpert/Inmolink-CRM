import { createHash } from 'node:crypto';
import { MEDIA_MAX_BYTES, MEDIA_UPLOAD_TYPES, Sha256Hex } from '@inmolink/contracts';
import { withMedia } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { type BucketName, storage } from '@inmolink/platform/storage';
import { z } from 'zod';
import { mediaEvents } from './events';
import { ImageInputError, normalizeOriginal, renderVariants, withImageSlot } from './processing';
import * as repo from './repo';
import { mapLimit, ORIGINALS_BUCKET, originalKey } from './service';
import {
  ALL_VARIANTS_MASK,
  MEDIA_PIPELINE_VERSION,
  masterKey,
  VARIANT_NAMES,
  VARIANTS,
  type VariantName,
  variantKey,
  variantsIn,
  variantsMask,
} from './variants';

/** An object nothing references any more is deleted this long after its last reference went (S3-03). */
export const MEDIA_DELETE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Originals no record needs (uploaded but never registered, or left after processing) are swept once this old. */
export const ORIGINAL_SWEEP_AGE_MS = DAY_MS;
/** A recorded object still unprocessed this long after it was recorded is queued again. */
export const REPROCESS_AFTER_MS = HOUR_MS;
/** A normalized master is far below this (2560 px WebP); anything bigger is not ours. */
const MASTER_MAX_BYTES = 32 * 1024 * 1024;
const PRUNE_BATCH = 100;
const PRUNE_MAX_BATCHES = 50;
const SWEEP_PAGE = 500;
const SWEEP_MAX_PAGES = 200;
const STORAGE_CONCURRENCY = 16;
const REPROCESS_BATCH = 500;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const CONTENT_TYPE = { webp: 'image/webp', jpeg: 'image/jpeg' } as const;
/** Masters, like originals, stay in the work bucket; only variants are in the (publicly served) `media` bucket. */
const MASTERS_BUCKET: BucketName = 'work';

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hourBucket = () => Math.floor(clock.now().getTime() / HOUR_MS);

type StoredFile = { bucket: BucketName; key: string };

/** Every file a stored object may have besides its original: the master and each pipeline's variants. */
function derivedFiles(sha256: string): StoredFile[] {
  const files: StoredFile[] = [{ bucket: MASTERS_BUCKET, key: masterKey(sha256) }];
  for (let p = 1; p <= MEDIA_PIPELINE_VERSION; p++) {
    for (const name of VARIANT_NAMES) files.push({ bucket: 'media', key: variantKey(sha256, name, p) });
  }
  return files;
}

/** Deletes files (idempotent); true when every delete succeeded. */
async function deleteFiles(files: StoredFile[]): Promise<boolean> {
  const results = await Promise.allSettled(files.map((f) => storage().delete(f.bucket, f.key)));
  return results.every((r) => r.status === 'fulfilled');
}

const processPayload = z.object({
  sha256: Sha256Hex,
  /** The tenant whose upload started it (fair share); null for system runs (on demand, reconciler). */
  agencyId: z.uuid().nullable(),
  /** Set when a request verified the upload: the job records the object itself if the sync has not yet. */
  upload: z.object({ sizeBytes: z.number().int().positive(), contentType: z.enum(MEDIA_UPLOAD_TYPES) }).nullable(),
  /** Only these sizes (on demand); every size when absent. */
  sizes: z
    .array(z.enum(VARIANT_NAMES as [VariantName, ...VariantName[]]))
    .min(1)
    .optional(),
  /**
   * What asked for this run, part of the job ID: the upload's event ID (a new upload of the same file is a new
   * run even if an earlier one failed), or `od-<hour>` / `retry-<hour>` for on-demand and reconciler runs.
   */
  trigger: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});

/** An input the image library cannot read will not read on a retry either. */
async function permanentOnBadImage<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof ImageInputError) throw new UnrecoverableError(err.message);
    throw err;
  }
}

/**
 * Processing an unprocessed object failed for good: its original goes (it carries the EXIF and will never be
 * processed), and its record goes too — or, when listings use it, is marked failed so the next check asks for
 * a fresh upload.
 */
async function giveUp(sha256: string, reason: string): Promise<never> {
  await storage().delete(ORIGINALS_BUCKET, originalKey(sha256));
  await withMedia('media.processObject', (tx) => repo.failUnprocessed(tx, sha256));
  throw new UnrecoverableError(reason);
}

/**
 * media worker jobs (PATTERNS §12), pool `media`. Idempotent, per-tenant fair share.
 *
 * `media.syncObjects` (one per `media.object.referencesChanged` event): records the objects a request verified
 * in storage (`media_objects`, insert-if-missing) and recounts the references of every object in the event —
 * a count, not an increment, so a repeated, late or reordered delivery writes the same truth. At zero
 * references `delete_after` is set `MEDIA_DELETE_GRACE_DAYS` ahead; the orphan cleanup deletes the object
 * after that unless a new reference cleared it.
 *
 * `media.processObject` (S3-04; one per uploaded object from the same event, on demand for missing sizes, and
 * from the reconciler): re-hashes the original (the bytes must be what the key says), normalizes it into the
 * private master (≤ 2560 px, EXIF orientation applied then every metadata block dropped, HEIC → WebP), renders
 * the variants from the master, stores them under deterministic keys (`variants.ts`) and records
 * `variants_ready`, size and pHash; then deletes the original (it carries the EXIF and is never served).
 * Missing sizes — or every size after a pipeline version bump — are rendered from the stored master,
 * byte-identical to the first run. Image bytes are only held inside an image slot (`withImageSlot`).
 *
 * `media.pruneOrphans` (schedule: every hour): objects whose grace period passed and that nothing references
 * (counted again under a row lock) lose their master and variants first, then their record — a failed delete
 * keeps the record, so the next run retries instead of leaking files. Then sweeps `originals/` objects older
 * than a day that no record needs.
 *
 * `media.reprocessStale` (schedule: every hour): queues again the objects recorded more than an hour ago and
 * still unprocessed (their job ran out of retries during an outage, or their files were lost to a race).
 */
export const mediaJobs = {
  syncObjects: defineJob({
    name: 'media.syncObjects',
    pool: 'media',
    payload: z.object({
      eventId: z.uuid(),
      agencyId: z.uuid(),
      objects: mediaEvents.referencesChanged.schema.shape.objects,
    }),
    jobId: (p) => `media.sync:${p.eventId}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      const deleteAt = new Date(clock.now().getTime() + MEDIA_DELETE_GRACE_DAYS * DAY_MS);
      const updated = await withMedia('media.syncObjects', async (tx) => {
        await repo.insertObjects(
          tx,
          p.objects.flatMap((o) => (o.upload ? [{ sha256: o.sha256, ...o.upload }] : [])),
        );
        return repo.recount(
          tx,
          p.objects.map((o) => o.sha256),
          deleteAt,
        );
      });
      // An object the platform never recorded (its upload event not processed yet) is counted on that event.
      log.info({ objects: p.objects.length, updated }, 'media objects recounted');
    },
  }),

  processObject: defineJob({
    name: 'media.processObject',
    pool: 'media',
    payload: processPayload,
    jobId: (p) =>
      `media.process:v${MEDIA_PIPELINE_VERSION}:${p.sha256}:${p.sizes ? [...p.sizes].sort().join('+') : 'all'}:${p.trigger}`,
    group: (p) => p.agencyId ?? 'media.system',
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 120_000,
    async run(p, { log }) {
      const state = await withMedia('media.processObject', async (tx) => {
        if (p.upload) await repo.insertObjects(tx, [{ sha256: p.sha256, ...p.upload }]);
        return repo.objectState(tx, p.sha256);
      });
      // Not recorded: deleted since — nothing to make.
      if (!state) return { made: 0 };

      const ready = state.pipeline === MEDIA_PIPELINE_VERSION ? state.variantsReady : 0;
      const wanted = (p.sizes ? variantsMask(p.sizes) : ALL_VARIANTS_MASK) & ~ready;
      if (wanted === 0) {
        // Processed already: an original uploaded again (the object was pending deletion) is not kept.
        await storage().delete(ORIGINALS_BUCKET, originalKey(p.sha256));
        return { made: 0 };
      }

      const heavy = state.contentType === 'image/heic';
      const result = await withImageSlot(heavy, async () => {
        let missing = wanted;
        let wroteMaster = false;
        let master =
          state.pipeline === null
            ? null
            : await storage().get(MASTERS_BUCKET, masterKey(p.sha256), { maxBytes: MASTER_MAX_BYTES });
        if (!master) {
          const original = await storage().get(ORIGINALS_BUCKET, originalKey(p.sha256), { maxBytes: MEDIA_MAX_BYTES });
          if (!original) return giveUp(p.sha256, 'media original missing');
          // Other bytes under this key: the signed checksum is the store's to enforce (S3-03 Decisions).
          if (sha256Of(original) !== p.sha256) return giveUp(p.sha256, 'media original does not match its hash');
          let normalized: Awaited<ReturnType<typeof normalizeOriginal>>;
          try {
            normalized = await normalizeOriginal(original, state.contentType);
          } catch (err) {
            if (err instanceof ImageInputError) return giveUp(p.sha256, err.message);
            throw err;
          }
          master = normalized.master;
          await storage().put(MASTERS_BUCKET, masterKey(p.sha256), master, { contentType: 'image/webp' });
          wroteMaster = true;
          missing = ALL_VARIANTS_MASK;
        }
        const rendered = await permanentOnBadImage(renderVariants(master, variantsIn(missing)));
        const written: StoredFile[] = [...rendered.files.keys()].map((name) => ({
          bucket: 'media',
          key: variantKey(p.sha256, name),
        }));
        await mapLimit([...rendered.files], STORAGE_CONCURRENCY, ([name, bytes]) =>
          storage().put('media', variantKey(p.sha256, name), bytes, {
            contentType: CONTENT_TYPE[VARIANTS[name].format],
            cacheControl: IMMUTABLE,
          }),
        );
        return { missing, rendered, written, wroteMaster };
      });

      const recorded = await withMedia('media.processObject', (tx) =>
        repo.markProcessed(tx, p.sha256, {
          pipeline: MEDIA_PIPELINE_VERSION,
          bits: result.missing,
          width: result.rendered.width,
          height: result.rendered.height,
          phash: result.rendered.phash,
        }),
      );
      if (!recorded) {
        // The cleanup deleted the object while it was being processed: nothing may keep its files.
        const mine = result.wroteMaster
          ? [{ bucket: MASTERS_BUCKET, key: masterKey(p.sha256) }, ...result.written]
          : result.written;
        await deleteFiles(mine);
        return { made: 0 };
      }
      await storage().delete(ORIGINALS_BUCKET, originalKey(p.sha256));
      log.info({ variants: result.rendered.files.size, pipeline: MEDIA_PIPELINE_VERSION }, 'media object processed');
      return { made: result.rendered.files.size };
    },
  }),

  pruneOrphans: defineJob({
    name: 'media.pruneOrphans',
    pool: 'media',
    payload: z.object({}).strict(),
    every: HOUR_MS,
    attempts: 3,
    timeoutMs: 10 * 60_000,
    async run(_p, { log, signal }) {
      const now = clock.now();
      let deleted = 0;
      let kept = 0;
      let retried = 0;
      let reset = 0;
      for (let batch = 0; batch < PRUNE_MAX_BATCHES && !signal.aborted; batch++) {
        const due = await withMedia('media.pruneOrphans', (tx) => repo.claimDueObjects(tx, now, PRUNE_BATCH));
        kept += due.kept;
        // Files first, record last: while the record exists (due), every check asks for a fresh upload.
        const cleared = await mapLimit(due.unreferenced, STORAGE_CONCURRENCY, async (h) =>
          (await deleteFiles(derivedFiles(h))) ? h : null,
        );
        const gone = cleared.filter((h): h is string => h !== null);
        retried += due.unreferenced.length - gone.length;
        const back = await withMedia('media.pruneOrphans', (tx) => repo.deleteUnreferenced(tx, gone, now));
        reset += back;
        deleted += gone.length - back;
        if (due.unreferenced.length + due.kept < PRUNE_BATCH) break;
      }

      // Originals no record needs: never registered, processed already, or failed for good.
      const cutoff = now.getTime() - ORIGINAL_SWEEP_AGE_MS;
      let swept = 0;
      let after: string | undefined;
      for (let page = 0; page < SWEEP_MAX_PAGES && !signal.aborted; page++) {
        const listed = await storage().list(ORIGINALS_BUCKET, 'originals/', { limit: SWEEP_PAGE, after });
        const old = listed.objects
          .filter((o) => o.lastModified.getTime() <= cutoff)
          .map((o) => o.key.slice('originals/'.length))
          .filter((h) => Sha256Hex.safeParse(h).success);
        const keep = await withMedia('media.pruneOrphans', (tx) => repo.originalsToKeep(tx, old));
        const garbage = old.filter((h) => !keep.has(h));
        await mapLimit(garbage, STORAGE_CONCURRENCY, (h) => storage().delete(ORIGINALS_BUCKET, originalKey(h)));
        swept += garbage.length;
        if (!listed.next) break;
        after = listed.next;
      }
      if (retried > 0)
        log.warn({ retried }, 'files of orphaned media objects could not all be deleted; next run retries');
      log.info({ deleted, kept, reset, swept }, 'media orphans pruned');
      return { deleted, kept, reset, swept, retried };
    },
  }),

  reprocessStale: defineJob({
    name: 'media.reprocessStale',
    pool: 'media',
    payload: z.object({}).strict(),
    every: HOUR_MS,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log }) {
      const before = new Date(clock.now().getTime() - REPROCESS_AFTER_MS);
      const stale = await withMedia('media.reprocessStale', (tx) => repo.staleUnprocessed(tx, before, REPROCESS_BATCH));
      const trigger = `retry-${hourBucket()}`;
      await mapLimit(stale, STORAGE_CONCURRENCY, (sha256) =>
        mediaJobs.processObject.enqueue({ sha256, agencyId: null, upload: null, trigger }),
      );
      if (stale.length > 0) log.warn({ queued: stale.length }, 'unprocessed media objects queued again');
      return { queued: stale.length };
    },
  }),
};

/**
 * On demand (S3-04): renders the `sizes` of a stored object that are missing for the current pipeline (every
 * size when omitted) — e.g. a size asked for after a pipeline bump. A system API for the worker and read models:
 * a route that exposes it must authorize and rate-limit its caller. Idempotent (at most one run per object, sizes
 * and hour). Network I/O (the queue): never call inside a transaction.
 */
export async function requestVariants(sha256: string, sizes?: VariantName[]): Promise<void> {
  await mediaJobs.processObject.enqueue({ sha256, agencyId: null, upload: null, sizes, trigger: `od-${hourBucket()}` });
}
