/**
 * media use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network inside one.
 *
 * Upload pipeline (S3-03, PLAN §3 #33): the browser hashes each file and calls `checkUploads`; hashes the
 * platform stores already need no upload at all (zero bytes); the others get a signed PUT straight to object
 * storage, bound to the file's type, exact size and SHA-256 (the store refuses anything else), under the
 * content-addressed key `originals/<sha256>` in the private bucket. `registerUploads` then checks each new
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
  MEDIA_UPLOAD_TYPES,
  MEDIA_UPLOAD_URL_TTL_SECONDS,
  type MediaCheckBody,
  type MediaCheckResult,
  type RegisterMediaBody,
  type UpdateListingMediaBody,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
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
 * Originals (EXIF, GPS) are uploaded to the private bucket: the `media` bucket holds only variants, so it can
 * be served publicly as a whole (S3-04).
 */
export const ORIGINALS_BUCKET = 'private' as const;

/** Storage checks run at most this many at once per register call. */
const VERIFY_CONCURRENCY = 16;

type MediaUploadType = (typeof MEDIA_UPLOAD_TYPES)[number];
type VerifiedUpload = { sha256: string; sizeBytes: number; contentType: MediaUploadType };
type ObjectChange = { sha256: string; upload: Omit<VerifiedUpload, 'sha256'> | null };

/**
 * The listing's media as DTOs, each with a signed URL of its 320 px preview once the worker made it (S3-06).
 * Signing is local (no network call). The `media` bucket is not public yet (S3-F4 limits it to variant keys at
 * the edge), so the manager reads previews through short-lived signed URLs.
 */
async function toDtos(rows: repo.MediaListRow[]): Promise<ListingMediaDto[]> {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      sha256: row.sha256,
      kind: row.kind,
      position: row.position,
      isCover: row.isCover,
      altText: row.altText,
      roomType: row.roomType as ListingMediaDto['roomType'],
      thumbUrl:
        row.pipeline !== null && (row.variantsReady & VARIANTS.thumb.bit) !== 0
          ? await storage().signedGetUrl('media', variantKey(row.sha256, 'thumb', row.pipeline), {
              expiresInSeconds: MEDIA_THUMB_URL_TTL_SECONDS,
              responseContentType: 'image/webp',
            })
          : null,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

async function listDtos(ctx: Ctx, listingId: string): Promise<ListingMediaList> {
  return { items: await toDtos(await repo.listForListing(ctx.tx, listingId)) };
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

/** `POST /v1/media/check`: which files are stored already, and signed upload URLs for the others. */
export async function checkUploads(ctx: Ctx, input: MediaCheckBody): Promise<MediaCheckResult> {
  assertCan(ctx, 'media.manage');
  const stored = await repo.storedObjects(
    ctx.tx,
    input.files.map((f) => f.sha256),
  );
  const expiresAt = new Date(clock.now().getTime() + MEDIA_UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  // Signing is local (no network call), so it may run inside the transaction.
  const files = await Promise.all(
    input.files.map(async (f) => {
      // An object awaiting deletion, or whose processing failed, is uploaded again rather than trusted.
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
    await properties.lockListingForMedia(ctx, input.listingId);
    return repo.storedObjects(ctx.tx, hashes);
  });

  // Objects the platform has not verified yet (or awaiting deletion, or failed) are checked in storage now.
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
    if (fresh.length === 0) return { items: await toDtos(current) };
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
        const v = verified.get(m.sha256);
        return { sha256: m.sha256, upload: v ? { sizeBytes: v.sizeBytes, contentType: v.contentType } : null };
      }),
    );
    return { items: await toDtos(merged) };
  });
}

/** `GET /v1/listings/:id/media`: the listing's media in order (other agencies never see documents, RLS). */
export async function listListingMedia(ctx: Ctx, listingId: string): Promise<ListingMediaList> {
  await properties.assertListingReadable(ctx, listingId);
  return listDtos(ctx, listingId);
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
  if (kind === 'FLOOR_PLAN') await repo.ensureCover(ctx.tx, listing.id);
  return listDtos(ctx, listing.id);
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
  if (changed === 0) return { items: await toDtos(current) };
  return listDtos(ctx, listing.id);
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
  await emitReferencesChanged(ctx, listing.id, [{ sha256: removed.sha256, upload: null }]);
}
