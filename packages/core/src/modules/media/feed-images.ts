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
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { safeFetch } from '@inmolink/platform/safe-fetch';
import { detectFileType, storage } from '@inmolink/platform/storage';
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
  /** Downloads in flight per job (each up to `MAX_BYTES` in memory). */
  CONCURRENCY: 3,
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

/** Downloads one image: its bytes, hash and real type, or null when it is not a usable image. */
async function download(
  url: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; sha256: string; type: UploadType } | null> {
  try {
    const res = await safeFetch(url, {
      timeoutMs: FEED_IMAGES.FETCH_TIMEOUT_MS,
      maxBytes: Math.min(FEED_IMAGES.MAX_BYTES, MEDIA_MAX_BYTES),
      allowedContentTypes: FETCH_TYPES,
      allowMissingContentType: true,
      signal,
    });
    if (!res.ok) {
      res.body.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const type = detectFileType(bytes)?.contentType;
    if (!type || !UPLOAD_TYPES.has(type) || bytes.length === 0) return null;
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), type: type as UploadType };
  } catch {
    return null; // blocked destination, timeout, too large, wrong type: skipped (logged by the caller's counts)
  }
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
    if (trusted.has(file.sha256)) return { sha256: file.sha256, upload: null };
    let put = stored.get(file.sha256);
    if (!put) {
      put = storage().put(ORIGINALS_BUCKET, originalKey(file.sha256), file.bytes, { contentType: file.type });
      stored.set(file.sha256, put);
    }
    await put;
    return { sha256: file.sha256, upload: { sizeBytes: file.bytes.length, contentType: file.type } };
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
