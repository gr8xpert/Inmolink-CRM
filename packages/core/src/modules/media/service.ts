/**
 * media use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network inside one.
 *
 * Upload pipeline (S3-03, PLAN §3 #33): the browser hashes each file and calls `checkUploads` for a listing it
 * may change; hashes the agency already uses need no upload at all (zero bytes; S4-F1: a hash only another agency
 * stored is uploaded again — no platform-wide existence probe); the others get a signed PUT straight to object
 * storage, capped in bytes per agency per hour, bound to the file's type, exact size and SHA-256 (the store refuses anything else), under the
 * content-addressed key `originals/<sha256>` in the work bucket. `registerUploads` then checks each new
 * object in storage — size, and its magic bytes: non-images are deleted and refused — and attaches the files to
 * a listing. The media worker records new objects and recounts references (`media.syncObjects`), then processes
 * them (`media.processObject`, S3-04).
 */
import {
  type ListingMediaDto,
  type ListingMediaList,
  MEDIA_MAX_BYTES,
  MEDIA_PER_LISTING_MAX,
  MEDIA_THUMB_URL_TTL_SECONDS,
  MEDIA_UPLOAD_BYTES_PER_HOUR,
  MEDIA_UPLOAD_TYPES,
  MEDIA_UPLOAD_URL_TTL_SECONDS,
  type MediaCheckBody,
  type MediaCheckResult,
  parseVideoUrl,
  type RegisterMediaBody,
  type UpdateListingMediaBody,
  type VideoProvider,
  videoEmbedUrl,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type RateLimitRule, rateLimiter } from '@inmolink/platform/rate-limit';
import { detectFileType, SNIFF_BYTES, storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import * as properties from '../properties';
import { mediaEvents, OBJECTS_PER_EVENT } from './events';
import { assertCan } from './policy';
import * as repo from './repo';
import { VARIANTS, variantKey } from './variants';

/** The content-addressed key of an uploaded original (never served to browsers: variants are, S3-04). */
export const originalKey = (sha256: string) => `originals/${sha256}`;
/**
 * Originals (EXIF, GPS) are uploaded to the work bucket: the `media` bucket holds only variants, so it can be
 * served publicly as a whole (S3-04); the work bucket is not the private one, so the media container's
 * credentials never reach private documents (S3-F9).
 */
export const ORIGINALS_BUCKET = 'work' as const;

/** Bytes of signed upload URLs per agency per hour (S4-F1); counted when the URLs are signed. */
const UPLOAD_BYTES = {
  name: 'media.upload-bytes',
  scope: 'tenant',
  limit: MEDIA_UPLOAD_BYTES_PER_HOUR,
  windowSeconds: 3_600,
} as const satisfies RateLimitRule;

/** Storage checks run at most this many at once per register call. */
const VERIFY_CONCURRENCY = 16;

type MediaUploadType = (typeof MEDIA_UPLOAD_TYPES)[number];
type VerifiedUpload = { sha256: string; sizeBytes: number; contentType: MediaUploadType };
type ObjectChange = { sha256: string; upload: Omit<VerifiedUpload, 'sha256'> | null };

/**
 * The listing's media as DTOs, each with a signed URL of its 320 px preview once the worker made it (S3-06).
 * Signing is local (no network call). The `media` bucket is not public yet (S3-F4 limits it to variant keys at
 * the edge), so the manager reads previews through short-lived signed URLs. Hashes only for the owner agency
 * (`own`, S4-F1): variant keys use the keyed public id, never the hash.
 */
async function toDtos(rows: repo.MediaListRow[], own: boolean): Promise<ListingMediaDto[]> {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      sha256: own ? row.sha256 : null,
      kind: row.kind as ListingMediaDto['kind'],
      video:
        row.kind === 'VIDEO' && row.videoProvider && row.videoId
          ? {
              provider: row.videoProvider as VideoProvider,
              id: row.videoId,
              embedUrl: videoEmbedUrl(row.videoProvider as VideoProvider, row.videoId),
            }
          : null,
      position: row.position,
      isCover: row.isCover,
      altText: row.altText,
      roomType: row.roomType as ListingMediaDto['roomType'],
      thumbUrl:
        row.sha256 !== null && row.pipeline !== null && (row.variantsReady & VARIANTS.thumb.bit) !== 0
          ? await storage().signedGetUrl('media', variantKey(row.sha256, 'thumb', row.pipeline), {
              expiresInSeconds: MEDIA_THUMB_URL_TTL_SECONDS,
              responseContentType: 'image/webp',
            })
          : null,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

/** The listing's media for `ctx`: hashes only when `ctx`'s agency owns it (`listingAgencyId`). */
async function listDtos(ctx: Ctx, listingId: string, listingAgencyId: string): Promise<ListingMediaList> {
  return { items: await toDtos(await repo.listForListing(ctx.tx, listingId), listingAgencyId === ctx.tenant.agencyId) };
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** One INSERT for every chunk of the change (events stay under the payload cap). */
async function emitReferencesChanged(ctx: Ctx, listingId: string, objects: ObjectChange[]): Promise<void> {
  const messages = [];
  for (let i = 0; i < objects.length; i += OBJECTS_PER_EVENT) {
    messages.push(mediaEvents.referencesChanged({ listingId, objects: objects.slice(i, i + OBJECTS_PER_EVENT) }));
  }
  await emit(ctx.tx, messages);
}

/**
 * `POST /v1/media/check`: which files the agency stores already, and signed upload URLs for the others — for a
 * listing whose media the caller may change (S4-F1). The URLs' bytes count against the agency's hourly cap
 * (Redis, after the transaction); over it, nothing is signed.
 */
export async function checkUploads(run: CtxRunner, input: MediaCheckBody): Promise<MediaCheckResult> {
  const { agencyId, stored } = await run(async (ctx) => {
    assertCan(ctx, 'media.manage');
    const listing = await properties.lockListingForMedia(ctx, input.listingId);
    return {
      agencyId: listing.agencyId,
      stored: await repo.storedObjects(
        ctx.tx,
        listing.agencyId,
        input.files.map((f) => f.sha256),
      ),
    };
  });
  // An object awaiting deletion, whose processing failed, or the agency never used is uploaded rather than trusted.
  const toUpload = input.files.filter((f) => !stored.get(f.sha256)?.trusted);
  const bytes = toUpload.reduce((sum, f) => sum + f.sizeBytes, 0);
  if (bytes > 0) {
    const limit = await rateLimiter().consume(UPLOAD_BYTES, agencyId, bytes);
    if (!limit.allowed) throw new AppError('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
  }
  const expiresAt = new Date(clock.now().getTime() + MEDIA_UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  // Signing is local (no network call).
  const files = await Promise.all(
    input.files.map(async (f) => {
      if (stored.get(f.sha256)?.trusted) {
        return { sha256: f.sha256, status: 'STORED' as const, upload: null };
      }
      const put = await storage().signedPutUrl(ORIGINALS_BUCKET, originalKey(f.sha256), {
        expiresInSeconds: MEDIA_UPLOAD_URL_TTL_SECONDS,
        contentType: f.contentType,
        contentLength: f.sizeBytes,
        sha256Hex: f.sha256,
      });
      return { sha256: f.sha256, status: 'UPLOAD' as const, upload: { ...put, method: 'PUT' as const, expiresAt } };
    }),
  );
  return { files };
}

/**
 * An uploaded original, checked in storage with one ranged read: it exists, its size is within the cap, and its
 * first bytes are an accepted image type. Anything else is deleted (its key is its hash: no listing can be using
 * bytes that never passed this check) and refused. Network I/O: never call inside a transaction.
 */
async function verifyUpload(sha256: string): Promise<VerifiedUpload> {
  const key = originalKey(sha256);
  const read = await storage().getRange(ORIGINALS_BUCKET, key, 0, SNIFF_BYTES - 1);
  if (!read) throw new AppError('MEDIA_NOT_UPLOADED', { sha256 });
  const discard = () =>
    storage()
      .delete(ORIGINALS_BUCKET, key)
      .catch(() => {});
  if (read.sizeBytes <= 0 || read.sizeBytes > MEDIA_MAX_BYTES) {
    await discard();
    throw new AppError('PAYLOAD_TOO_LARGE', { sha256, maxBytes: MEDIA_MAX_BYTES });
  }
  const type = detectFileType(read.bytes);
  if (!type || !(MEDIA_UPLOAD_TYPES as readonly string[]).includes(type.contentType)) {
    await discard();
    throw new AppError('MEDIA_TYPE_NOT_ALLOWED', { sha256, allowed: [...MEDIA_UPLOAD_TYPES] });
  }
  return { sha256, sizeBytes: read.sizeBytes, contentType: type.contentType as MediaUploadType };
}

/**
 * `POST /v1/media/register`: attaches files (uploaded, or stored already) to the caller's listing, in order, at
 * `position` (default: the end). A file the listing has already is skipped, so a retried call is a no-op. Three
 * steps: authorize (a refused caller causes no storage I/O), verify new objects in storage outside any
 * transaction, then record under the listing's row lock (re-checking everything). The recording step is a
 * fixed handful of statements whatever the batch size; the answer is built in memory.
 */
export async function registerUploads(run: CtxRunner, input: RegisterMediaBody): Promise<ListingMediaList> {
  const hashes = input.files.map((f) => f.sha256);
  const stored = await run(async (ctx) => {
    assertCan(ctx, 'media.manage');
    const listing = await properties.lockListingForMedia(ctx, input.listingId);
    return repo.storedObjects(ctx.tx, listing.agencyId, hashes);
  });

  // Objects the agency does not use yet (S4-F1), not verified yet, awaiting deletion or failed are checked in
  // storage now: a hash alone attaches nothing.
  const unverified = hashes.filter((h) => !stored.get(h)?.trusted);
  const verified = new Map(
    (await mapLimit(unverified, VERIFY_CONCURRENCY, verifyUpload)).map((v) => [v.sha256, v] as const),
  );

  return run(async (ctx) => {
    assertCan(ctx, 'media.manage');
    const listing = await properties.lockListingForMedia(ctx, input.listingId);
    const current = await repo.listForListing(ctx.tx, listing.id);
    const attached = new Set(current.map((m) => m.sha256));
    const fresh = input.files.filter((f) => !attached.has(f.sha256));
    if (fresh.length === 0) return { items: await toDtos(current, true) };
    if (current.length + fresh.length > MEDIA_PER_LISTING_MAX) {
      throw new AppError('MEDIA_LIMIT_REACHED', { max: MEDIA_PER_LISTING_MAX, current: current.length });
    }

    const at = Math.min(input.position ?? current.length, current.length);
    const now = clock.now();
    const added: repo.MediaListRow[] = fresh.map((f, i) => ({
      id: newId(),
      sha256: f.sha256,
      kind: f.kind,
      position: at + i,
      isCover: f.cover === true,
      altText: f.altText ?? null,
      roomType: f.roomType ?? null,
      createdAt: now,
      videoProvider: null,
      videoId: null,
      // A trusted stored object may have its previews already; a new upload has none yet.
      pipeline: stored.get(f.sha256)?.trusted ? (stored.get(f.sha256)?.pipeline ?? null) : null,
      variantsReady: stored.get(f.sha256)?.trusted ? (stored.get(f.sha256)?.variantsReady ?? 0) : 0,
    }));
    const hadCover = current.some((m) => m.isCover);
    const newCover = added.some((m) => m.isCover);
    const merged = [
      ...current.map((m) => ({
        ...m,
        position: m.position >= at ? m.position + added.length : m.position,
        isCover: m.isCover && !newCover,
      })),
      ...added,
    ].sort((x, y) => x.position - y.position);
    // A listing with images always has a cover: without one, its first image (in the new order) becomes it.
    const firstImage = !hadCover && !newCover ? merged.find((m) => m.kind === 'IMAGE') : undefined;
    const firstIsNew = firstImage !== undefined && added.includes(firstImage);
    if (firstImage) firstImage.isCover = true;

    const clearCover = hadCover && newCover;
    if (at < current.length || clearCover) {
      await repo.makeRoom(ctx.tx, listing.id, { from: at, count: added.length, clearCover });
    }
    await repo.insertMedia(
      ctx.tx,
      added.map((m) => ({ ...m, propertyId: listing.id, agencyId: listing.agencyId })),
    );
    if (firstImage && !firstIsNew) await repo.ensureCover(ctx.tx, listing.id);
    await emitReferencesChanged(
      ctx,
      listing.id,
      added.map((m) => {
        // files only: every row added here has its hash
        const sha256 = m.sha256 as string;
        const v = verified.get(sha256);
        return { sha256, upload: v ? { sizeBytes: v.sizeBytes, contentType: v.contentType } : null };
      }),
    );
    return { items: await toDtos(merged, true) };
  });
}

/** `GET /v1/listings/:id/media`: the listing's media in order (other agencies never see documents, RLS). */
export async function listListingMedia(ctx: Ctx, listingId: string): Promise<ListingMediaList> {
  const listing = await properties.assertListingReadable(ctx, listingId);
  return listDtos(ctx, listingId, listing.agencyId);
}

/**
 * `PATCH /v1/listings/:id/media/:mediaId` (S3-06): kind (image or floor plan), cover, alt text, room type. A
 * cover turned into a floor plan passes the cover to the first image. Answers the listing's media.
 */
export async function updateListingMedia(
  ctx: Ctx,
  input: { listingId: string; mediaId: string; patch: UpdateListingMediaBody },
): Promise<ListingMediaList> {
  assertCan(ctx, 'media.manage');
  const listing = await properties.lockListingForMedia(ctx, input.listingId);
  const { kind, cover, altText, roomType } = input.patch;
  if (kind !== undefined || cover) {
    // A video stays a video and is never the cover (S3-F5).
    const row = (await repo.listForListing(ctx.tx, listing.id)).find((m) => m.id === input.mediaId);
    if (row?.kind === 'VIDEO') throw new AppError('VALIDATION_FAILED', { field: 'kind', reason: 'a video link' });
  }
  if (cover) {
    // Only an image can be the cover: this row's kind after the change.
    const current = (await repo.listForListing(ctx.tx, listing.id)).find((m) => m.id === input.mediaId);
    if (!current) throw new AppError('MEDIA_NOT_FOUND');
    if ((kind ?? current.kind) !== 'IMAGE') {
      throw new AppError('VALIDATION_FAILED', { field: 'cover', reason: 'only an image can be the cover' });
    }
  }
  const updated = await repo.updateMedia(ctx.tx, listing.id, input.mediaId, {
    ...(kind !== undefined ? { kind } : {}),
    ...(altText !== undefined ? { altText: altText === '' ? null : altText } : {}),
    ...(roomType !== undefined ? { roomType } : {}),
    ...(cover ? { cover } : {}),
  });
  if (!updated) throw new AppError('MEDIA_NOT_FOUND');
  // Either way the cover can move: a floor plan was the cover, or the listing's first image just appeared.
  if (kind !== undefined) await repo.ensureCover(ctx.tx, listing.id);
  await emit(ctx.tx, mediaEvents.listingChanged({ listingId: listing.id }));
  return listDtos(ctx, listing.id, listing.agencyId);
}

/**
 * `PUT /v1/listings/:id/media/order` (S3-06): the listing's media in the order given — every id exactly once,
 * else `MEDIA_ORDER_STALE` (another tab added or removed one). One statement whatever the count; the cover
 * stays where it is. Answers the listing's media.
 */
export async function reorderListingMedia(
  ctx: Ctx,
  input: { listingId: string; ids: string[] },
): Promise<ListingMediaList> {
  assertCan(ctx, 'media.manage');
  const listing = await properties.lockListingForMedia(ctx, input.listingId);
  const current = await repo.listForListing(ctx.tx, listing.id);
  const known = new Set(current.map((m) => m.id));
  if (input.ids.length !== current.length || !input.ids.every((id) => known.has(id))) {
    throw new AppError('MEDIA_ORDER_STALE', { expected: current.length });
  }
  const changed = await repo.reorder(ctx.tx, listing.id, input.ids);
  if (changed === 0) return { items: await toDtos(current, true) };
  await emit(ctx.tx, mediaEvents.listingChanged({ listingId: listing.id }));
  return listDtos(ctx, listing.id, listing.agencyId);
}

/**
 * `DELETE /v1/listings/:id/media/:mediaId`: removes a file from the listing (later ones move up; a removed
 * cover passes to the first image). The object's reference count is recounted by the worker; at zero it is
 * scheduled for deletion after the grace period (`MEDIA_DELETE_GRACE_DAYS`).
 */
export async function detachListingMedia(ctx: Ctx, input: { listingId: string; mediaId: string }): Promise<void> {
  assertCan(ctx, 'media.manage');
  const listing = await properties.lockListingForMedia(ctx, input.listingId);
  const removed = await repo.deleteMedia(ctx.tx, listing.id, input.mediaId);
  if (!removed) throw new AppError('MEDIA_NOT_FOUND');
  await repo.closeGap(ctx.tx, listing.id, removed.position);
  if (removed.isCover) await repo.ensureCover(ctx.tx, listing.id);
  // A video link references no stored object.
  if (removed.sha256) await emitReferencesChanged(ctx, listing.id, [{ sha256: removed.sha256, upload: null }]);
  else await emit(ctx.tx, mediaEvents.listingChanged({ listingId: listing.id }));
}

/**
 * `POST /v1/listings/:id/videos` (S3-F5): a YouTube, Vimeo or Matterport link, last in the listing's order (it is
 * reordered with the photos). Only those hosts, normalized to the provider and its id; the page is never fetched.
 */
export async function addListingVideo(ctx: Ctx, input: { listingId: string; url: string }): Promise<ListingMediaList> {
  assertCan(ctx, 'media.manage');
  const video = parseVideoUrl(input.url);
  if (!video) throw new AppError('VIDEO_URL_NOT_ALLOWED', { allowed: ['youtube', 'vimeo', 'matterport'] });
  const listing = await properties.lockListingForMedia(ctx, input.listingId);
  const current = await repo.listForListing(ctx.tx, listing.id);
  if (current.some((m) => m.videoProvider === video.provider && m.videoId === video.id)) {
    throw new AppError('VIDEO_ALREADY_ADDED');
  }
  if (current.length >= MEDIA_PER_LISTING_MAX) {
    throw new AppError('MEDIA_LIMIT_REACHED', { max: MEDIA_PER_LISTING_MAX });
  }
  await repo.insertMedia(ctx.tx, [
    {
      id: newId(),
      propertyId: listing.id,
      agencyId: listing.agencyId,
      sha256: null,
      kind: 'VIDEO',
      videoProvider: video.provider,
      videoId: video.id,
      position: current.length,
    },
  ]);
  await emit(ctx.tx, mediaEvents.listingChanged({ listingId: listing.id }));
  return listDtos(ctx, listing.id, listing.agencyId);
}

/**
 * For the quality module (S3-08): the pixel size of each photo of a listing `tx` can see, null while unprocessed.
 * Takes a raw `tx` (request under RLS, or the quality job's tenant transaction); the caller authorizes.
 */
export function listingImageSizes(tx: Tx, listingId: string): Promise<({ width: number; height: number } | null)[]> {
  return repo.imageSizes(tx, listingId);
}

/** `listingImageSizes` for a batch of listings (S6-F3, the quality queue): one statement; every id has an entry. */
export async function listingsImageSizes(
  tx: Tx,
  listingIds: readonly string[],
): Promise<Map<string, ({ width: number; height: number } | null)[]>> {
  const out = new Map<string, ({ width: number; height: number } | null)[]>(listingIds.map((id) => [id, []]));
  for (const r of await repo.imageSizesOf(tx, [...new Set(listingIds)])) {
    out.get(r.propertyId)?.push(r.width !== null && r.height !== null ? { width: r.width, height: r.height } : null);
  }
  return out;
}
