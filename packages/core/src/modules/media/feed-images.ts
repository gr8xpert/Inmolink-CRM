/**
 * Feed images (S6-02, PLAN §3 #33): the import queues a listing's image URLs in its batch transaction
 * (`queueFeedImages`, no network); the `media.importFeedImages` worker fetches them later, outside any transaction.
 *
 * Hash-first: a URL this agency fetched before maps to the hash it served (`feed_image_sources`) and is not
 * downloaded again while the agency still uses that object; a downloaded file is hashed before anything is stored,
 * and an object the agency stores already is not uploaded again. Downloads go through `safeFetch` (SSRF checks on
 * every hop, deadline, byte cap) and must be an image by their magic bytes. New files are attached after the
 * listing's media, in feed order (the first image becomes the cover of a listing without one); files the listing has
 * already are skipped. Media the agent added stay; images that left the feed stay too (no origin per media row yet).
 * A URL that fails (HTTP error, not an image, too big) is skipped and fetched again only when the feed's image list
 * changes.
 */
import { createHash } from 'node:crypto';
import { MEDIA_MAX_BYTES, MEDIA_PER_LISTING_MAX, MEDIA_UPLOAD_TYPES } from '@inmolink/contracts';
import { type Tx, withSystem, withTenant } from '@inmolink/db';
import { importsEnv, loadConfig } from '@inmolink/platform/config';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { safeFetch } from '@inmolink/platform/safe-fetch';
import {
  detectFileType,
  MIN_UPLOAD_PART_BYTES,
  type ObjectUpload,
  SNIFF_BYTES,
  storage,
} from '@inmolink/platform/storage';
import * as properties from '../properties';
import { mediaEvents, OBJECTS_PER_EVENT } from './events';
import * as fr from './feed-images-repo';
import * as repo from './repo';
import { mapLimit, ORIGINALS_BUCKET, originalKey } from './service';

export const FEED_IMAGES = {
  /** Listings claimed per transaction. */
  CLAIM_BATCH: 20,
  /** A claim's lease: a worker that died frees its listings after this. */
  LEASE_MS: 10 * 60_000,
  /**
   * Downloads in flight per job. Each holds at most `HOLD_BYTES` (5 MiB) of the file, or — streamed past that — the
   * storage adapter's one 5 MiB part: about 6 MB per download, ≈ 18 MB per job (S7-F3; was 2 × `MAX_BYTES` per
   * download, ~120 MB per job, ~1.2 GB for the pool's 10 jobs in one process).
   */
  CONCURRENCY: 3,
  /**
   * A file up to this size is held once, hashed and stored with one PUT (most feed photos are well below); a larger
   * one streams to a staging key as it arrives and is moved to its content-addressed key once hashed (S7-F3). One
   * multipart part: holding more costs no more memory than streaming, and saves the staging requests and the copy.
   */
  HOLD_BYTES: MIN_UPLOAD_PART_BYTES,
  /** A feed image larger than this is skipped (uploads may be up to `MEDIA_MAX_BYTES`; feed photos are web-sized). */
  MAX_BYTES: 20 * 1024 * 1024,
  /** One image download's deadline. */
  FETCH_TIMEOUT_MS: 30_000,
  /** A job stops claiming after this; the rest waits for the next run (asked for at the end). */
  RUN_BUDGET_MS: 4 * 60_000,
  /** Queued images wait this long for more of the run before a job starts (throttled per agency). */
  THROTTLE_MS: 5_000,
  /** Rows unclaimed this long are swept: their job was lost. */
  OVERDUE_MS: 15 * 60_000,
} as const;

/** S7-F3 overrides of the `importsEnv` caps (worker boot, tests); read from the environment when not given. */
let caps: { maxConcurrentJobs?: number; jobsPerProcess?: number } = {};

export function configureFeedImages(next: { maxConcurrentJobs?: number; jobsPerProcess?: number }): void {
  caps = next;
}

/** Feed-image jobs running at once across the `imports` pool (`IMPORT_IMAGE_JOBS_MAX_CONCURRENT`). */
export function feedImageJobsMax(): number {
  return caps.maxConcurrentJobs ?? loadConfig(importsEnv).IMPORT_IMAGE_JOBS_MAX_CONCURRENT;
}

/** Feed-image jobs one worker process runs at once (`IMPORT_IMAGE_JOBS_PER_PROCESS`): bounds the process's RSS. */
export function feedImageJobsPerProcess(): number {
  return caps.jobsPerProcess ?? loadConfig(importsEnv).IMPORT_IMAGE_JOBS_PER_PROCESS;
}

/** What an image server may answer with (the magic bytes decide). */
const FETCH_TYPES = [...MEDIA_UPLOAD_TYPES, 'image/jpg', 'image/pjpeg', 'application/octet-stream'];

type UploadType = (typeof MEDIA_UPLOAD_TYPES)[number];
const UPLOAD_TYPES: ReadonlySet<string> = new Set(MEDIA_UPLOAD_TYPES);

const urlKeyOf = (url: string) => createHash('sha256').update(url).digest('hex');

/**
 * Queues the image URLs of listings the import created or whose image list changed (inside the batch transaction:
 * one statement, one event for the agency's run). No network.
 */
export async function queueFeedImages(
  tx: Tx,
  agencyId: string,
  rows: readonly { listingId: string; urls: readonly string[] }[],
): Promise<void> {
  const queued = rows
    .map((r) => ({ listingId: r.listingId, urls: [...new Set(r.urls)].slice(0, MEDIA_PER_LISTING_MAX) }))
    .filter((r) => r.urls.length > 0);
  if (queued.length === 0) return;
  await fr.upsertQueue(tx, agencyId, queued);
  await emit(tx, mediaEvents.feedImagesQueued({ listings: queued.length }), { agencyId });
}

interface Fetched {
  sha256: string;
  /** Set when this job stored the file (or found it unknown to the agency): the worker records the object. */
  upload: { sizeBytes: number; contentType: UploadType } | null;
}

/**
 * One downloaded image, hashed as it streamed in: a file up to `FEED_IMAGES.HOLD_BYTES` is held once (`bytes`, no
 * chunk list and no concatenated copy); a larger one went up to `staged` (a key under `FEED_STAGING_PREFIX` in the
 * work bucket) part by part as it arrived, so at most one part of it (and the copy being sent) is in memory (S7-F3).
 */
interface Downloaded {
  sha256: string;
  type: UploadType;
  sizeBytes: number;
  bytes: Buffer | null;
  staged: string | null;
}

/**
 * Images past `FEED_IMAGES.HOLD_BYTES` stream here (work bucket) until hashed. A completed staging object lives for one
 * download and its move; `media.pruneOrphans` deletes those older than `FEED_STAGING_SWEEP_AGE_MS` (a job that died in
 * between). Multipart uploads a dead job never completed are invisible to that listing: the bucket's lifecycle rule
 * aborts them after a day (`AbortIncompleteMultipartUpload`, prefix `feed-staging/`; HUMAN-ACTIONS H3, deploy runbook).
 */
export const FEED_STAGING_PREFIX = 'feed-staging/';

/** A staging object older than any job could still be using it: a claim's lease plus one download, with a margin. */
export const FEED_STAGING_SWEEP_AGE_MS = FEED_IMAGES.LEASE_MS + FEED_IMAGES.FETCH_TIMEOUT_MS + 5 * 60_000;

/**
 * Downloads one image, hashing it and checking its magic bytes as it streams, or null when it is not a usable image
 * (blocked destination, HTTP error, timeout, too large, not an image). A storage failure is thrown (the job retries).
 */
async function download(url: string, signal: AbortSignal): Promise<Downloaded | null> {
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, {
      timeoutMs: FEED_IMAGES.FETCH_TIMEOUT_MS,
      maxBytes: Math.min(FEED_IMAGES.MAX_BYTES, MEDIA_MAX_BYTES),
      allowedContentTypes: FETCH_TYPES,
      allowMissingContentType: true,
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    res.body.destroy();
    return null;
  }
  const hash = createHash('sha256');
  const sniff = Buffer.alloc(SNIFF_BYTES);
  let sniffed = 0;
  let type: UploadType | null = null;
  // The declared length sizes the buffer (a lying one only moves the file to the streamed path). Never below
  // `SNIFF_BYTES`: the streamed path starts only past the buffer, so the file's type is known by then.
  const declared = Number(res.headers['content-length']);
  let head: Buffer | null = Buffer.allocUnsafe(
    Number.isInteger(declared) && declared > 0
      ? Math.max(SNIFF_BYTES, Math.min(declared, FEED_IMAGES.HOLD_BYTES))
      : FEED_IMAGES.HOLD_BYTES,
  );
  let fill = 0;
  let size = 0;
  let upload: ObjectUpload | null = null;
  let staged: string | null = null;
  const typeOf = (bytes: Uint8Array): UploadType | null => {
    const t = detectFileType(bytes)?.contentType;
    return t && UPLOAD_TYPES.has(t) ? (t as UploadType) : null;
  };
  // Read errors (timeout, too large, cancelled, connection lost) skip the image; storage errors are thrown.
  const chunks = res.body[Symbol.asyncIterator]();
  const skip = async () => {
    res.body.destroy();
    await upload?.abort().catch(() => undefined);
    return null;
  };
  try {
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = await chunks.next();
      } catch {
        return await skip();
      }
      if (next.done) break;
      const chunk = next.value;
      hash.update(chunk);
      size += chunk.length;
      if (sniffed < SNIFF_BYTES) {
        sniffed += chunk.copy(sniff, sniffed, 0, Math.min(chunk.length, SNIFF_BYTES - sniffed));
        if (sniffed === SNIFF_BYTES) {
          type = typeOf(sniff);
          if (!type) return await skip(); // not an image: stop reading
        }
      }
      if (upload) {
        await upload.write(chunk);
      } else if (head && fill + chunk.length <= head.length) {
        fill += chunk.copy(head, fill);
      } else if (head) {
        if (!type) return await skip(); // cannot happen: the buffer holds at least the sniffed bytes
        // Past `HOLD_BYTES`: the rest streams to a staging key (multipart, the smallest parts S3 allows), and the hash
        // decides its final key once the download ends.
        staged = `${FEED_STAGING_PREFIX}${newId()}`;
        upload = storage().upload(ORIGINALS_BUCKET, staged, {
          contentType: type,
          partBytes: MIN_UPLOAD_PART_BYTES,
        });
        await upload.write(head.subarray(0, fill));
        head = null;
        await upload.write(chunk);
      }
    }
    if (!type) type = typeOf(sniff.subarray(0, sniffed));
    if (!type || size === 0) return await skip();
    if (upload) await upload.complete();
    return { sha256: hash.digest('hex'), type, sizeBytes: size, bytes: head ? head.subarray(0, fill) : null, staged };
  } catch (err) {
    await skip();
    throw err;
  }
}

/** Stores a downloaded file under its content-addressed key: the held bytes, or the staged object moved there. */
async function storeOriginal(file: Downloaded): Promise<void> {
  const key = originalKey(file.sha256);
  if (file.bytes) {
    await storage().put(ORIGINALS_BUCKET, key, file.bytes, { contentType: file.type });
    return;
  }
  if (!file.staged) return;
  await storage().copy(ORIGINALS_BUCKET, file.staged, key);
  await discardStaged(file);
}

/** Drops a file's staging object (best effort: `media.pruneOrphans` sweeps whatever is left). */
async function discardStaged(file: Downloaded): Promise<void> {
  if (file.staged)
    await storage()
      .delete(ORIGINALS_BUCKET, file.staged)
      .catch(() => undefined);
}

export interface FeedImagesResult {
  listings: number;
  downloaded: number;
  reused: number;
  failed: number;
  attached: number;
  /** Rows still waiting when the run stopped (budget or signal). */
  more: boolean;
}

/** One claimed batch: resolve hash-first, fetch the rest, store new files, attach in one transaction. */
async function importBatch(
  agencyId: string,
  claimed: fr.ClaimedImages[],
  signal: AbortSignal,
  total: FeedImagesResult,
): Promise<void> {
  const keys = [...new Set(claimed.flatMap((c) => c.urls))].map(urlKeyOf);
  const { known, trusted } = await withTenant({ agencyId }, async (tx) => {
    const k = await fr.sourcesFor(tx, agencyId, keys);
    const stored = await repo.storedObjects(tx, agencyId, [...new Set(k.values())]);
    return { known: k, trusted: new Set([...stored].filter(([, s]) => s.trusted).map(([h]) => h)) };
  });

  // Each distinct URL once per batch (listings of one feed share photos), and each new file stored once.
  const urls = [...new Set(claimed.flatMap((c) => c.urls))];
  const sources: { urlKey: string; sha256: string }[] = [];
  const stored = new Map<string, Promise<void>>();
  const fetched = await mapLimit(urls, FEED_IMAGES.CONCURRENCY, async (url): Promise<Fetched | null> => {
    const key = urlKeyOf(url);
    const hash = known.get(key);
    if (hash && trusted.has(hash)) {
      total.reused += 1;
      return { sha256: hash, upload: null };
    }
    const file = await download(url, signal);
    if (!file) {
      total.failed += 1;
      return null;
    }
    total.downloaded += 1;
    sources.push({ urlKey: key, sha256: file.sha256 });
    if (trusted.has(file.sha256)) {
      await discardStaged(file);
      return { sha256: file.sha256, upload: null };
    }
    let put = stored.get(file.sha256);
    if (!put) {
      put = storeOriginal(file);
      stored.set(file.sha256, put);
    } else {
      await discardStaged(file);
    }
    await put;
    return { sha256: file.sha256, upload: { sizeBytes: file.sizeBytes, contentType: file.type } };
  });
  const byUrl = new Map(urls.map((u, i) => [u, fetched[i] ?? null]));
  // Cancelled (shutdown, timeout) mid-batch: failed downloads may be the cancellation's — the listings wait for the
  // next run instead of losing those images.
  if (signal.aborted) {
    await withTenant({ agencyId }, (tx) => fr.release(tx, claimed));
    return;
  }

  await withTenant({ agencyId }, async (tx) => {
    const live = new Set(
      await properties.lockListingsForFeedImages(
        tx,
        agencyId,
        claimed.map((c) => c.propertyId),
      ),
    );
    const summaries = await fr.summaries(tx, [...live]);
    const inserts: repo.MediaInsert[] = [];
    const changed = new Map<string, Fetched[]>();
    for (const c of claimed) {
      const files = c.urls.map((u) => byUrl.get(u) ?? null);
      const s = summaries.get(c.propertyId);
      if (!live.has(c.propertyId) || !s) continue;
      for (const f of files) {
        if (!f || s.hashes.has(f.sha256) || s.count >= MEDIA_PER_LISTING_MAX) continue;
        s.hashes.add(f.sha256);
        inserts.push({
          id: newId(),
          propertyId: c.propertyId,
          agencyId,
          sha256: f.sha256,
          kind: 'IMAGE',
          position: s.nextPosition,
          isCover: !s.hasCover,
        });
        s.hasCover = true;
        s.count += 1;
        s.nextPosition += 1;
        changed.set(c.propertyId, [...(changed.get(c.propertyId) ?? []), f]);
      }
    }
    await repo.insertMedia(tx, inserts);
    await fr.upsertSources(tx, agencyId, sources);
    await fr.complete(tx, claimed);
    const messages = [];
    for (const [listingId, files] of changed) {
      for (let i = 0; i < files.length; i += OBJECTS_PER_EVENT) {
        messages.push(
          mediaEvents.referencesChanged({
            listingId,
            objects: files.slice(i, i + OBJECTS_PER_EVENT).map((f) => ({ sha256: f.sha256, upload: f.upload })),
          }),
        );
      }
    }
    await emit(tx, messages, { agencyId });
    total.attached += inserts.length;
  });
}

/**
 * `media.importFeedImages` for one agency: claims its waiting listings a batch at a time until none is left, the
 * budget is spent or the job is cancelled.
 */
export async function importFeedImages(
  agencyId: string,
  options: { signal: AbortSignal; log: Pick<Logger, 'debug'> },
): Promise<FeedImagesResult> {
  const total: FeedImagesResult = { listings: 0, downloaded: 0, reused: 0, failed: 0, attached: 0, more: false };
  const stopAt = Date.now() + FEED_IMAGES.RUN_BUDGET_MS;
  while (!options.signal.aborted) {
    if (Date.now() > stopAt) {
      total.more = true;
      break;
    }
    const claimed = await withTenant({ agencyId }, (tx) =>
      fr.claim(tx, agencyId, FEED_IMAGES.CLAIM_BATCH, FEED_IMAGES.LEASE_MS),
    );
    if (claimed.length === 0) break;
    total.listings += claimed.length;
    await importBatch(agencyId, claimed, options.signal, total);
  }
  options.log.debug({ agencyId, ...total }, 'feed images imported');
  return total;
}

/** Agencies whose waiting rows nobody claimed for a while (their job was lost). */
export function overdueFeedImageAgencies(limit: number): Promise<string[]> {
  return withSystem('media.sweepFeedImages', (tx) => fr.overdueAgencies(tx, FEED_IMAGES.OVERDUE_MS, limit));
}
