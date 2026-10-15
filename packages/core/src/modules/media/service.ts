/**
 * media use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network inside one.
 *
 * Upload pipeline (S3-03, PLAN §3 #33): the browser hashes each file and calls `checkUploads`; hashes the
 * platform stores already need no upload at all (zero bytes); the others get a signed PUT straight to object
 * storage, bound to the file's type, exact size and SHA-256 (the store refuses anything else), under the
 * content-addressed key `originals/<sha256>`. `registerUploads` then checks each new object in storage — size,
 * and its magic bytes: non-images are deleted and refused — and attaches the files to a listing. The media
 * worker records new objects and recounts references (`media.syncObjects`).
 */
import {
  type ListingMediaDto,
  type ListingMediaList,
  MEDIA_MAX_BYTES,
  MEDIA_PER_LISTING_MAX,
  MEDIA_UPLOAD_TYPES,
  MEDIA_UPLOAD_URL_TTL_SECONDS,
  type MediaCheckBody,
  type MediaCheckResult,
  type RegisterMediaBody,
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

/** The content-addressed key of an uploaded original (never served to browsers: variants are, S3-04). */
export const originalKey = (sha256: string) => `originals/${sha256}`;

/** Storage checks run at most this many at once per register call. */
const VERIFY_CONCURRENCY = 16;

type MediaUploadType = (typeof MEDIA_UPLOAD_TYPES)[number];
type VerifiedUpload = { sha256: string; sizeBytes: number; contentType: MediaUploadType };
type ObjectChange = { sha256: string; upload: Omit<VerifiedUpload, 'sha256'> | null };

function toDto(row: repo.MediaRow): ListingMediaDto {
  return {
    id: row.id,
    sha256: row.sha256,
    kind: row.kind,
    position: row.position,
    isCover: row.isCover,
    altText: row.altText,
    createdAt: row.createdAt.toISOString(),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
      // An unreferenced object awaiting deletion is uploaded again rather than trusted to survive.
      if (stored.has(f.sha256) && !stored.get(f.sha256)?.deleteAfter) {
        return { sha256: f.sha256, status: 'STORED' as const, upload: null };
      }
      const put = await storage().signedPutUrl('media', originalKey(f.sha256), {
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
  const read = await storage().getRange('media', key, 0, SNIFF_BYTES - 1);
  if (!read) throw new AppError('MEDIA_NOT_UPLOADED', { sha256 });
  const discard = () =>
    storage()
      .delete('media', key)
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

  // Objects the platform has not verified yet (or that await deletion) are checked in storage now.
  const unverified = hashes.filter((h) => !stored.has(h) || stored.get(h)?.deleteAfter);
  const verified = new Map(
    (await mapLimit(unverified, VERIFY_CONCURRENCY, verifyUpload)).map((v) => [v.sha256, v] as const),
  );

  return run(async (ctx) => {
    assertCan(ctx, 'media.manage');
    const listing = await properties.lockListingForMedia(ctx, input.listingId);
    const current = await repo.listForListing(ctx.tx, listing.id);
    const attached = new Set(current.map((m) => m.sha256));
    const fresh = input.files.filter((f) => !attached.has(f.sha256));
    if (fresh.length === 0) return { items: current.map(toDto) };
    if (current.length + fresh.length > MEDIA_PER_LISTING_MAX) {
      throw new AppError('MEDIA_LIMIT_REACHED', { max: MEDIA_PER_LISTING_MAX, current: current.length });
    }

    const at = Math.min(input.position ?? current.length, current.length);
    const now = clock.now();
    const added: repo.MediaRow[] = fresh.map((f, i) => ({
      id: newId(),
      sha256: f.sha256,
      kind: f.kind,
      position: at + i,
      isCover: f.cover === true,
      altText: f.altText ?? null,
      createdAt: now,
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
    return { items: merged.map(toDto) };
  });
}

/** `GET /v1/listings/:id/media`: the listing's media in order (other agencies never see documents, RLS). */
export async function listListingMedia(ctx: Ctx, listingId: string): Promise<ListingMediaList> {
  await properties.assertListingReadable(ctx, listingId);
  return { items: (await repo.listForListing(ctx.tx, listingId)).map(toDto) };
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
