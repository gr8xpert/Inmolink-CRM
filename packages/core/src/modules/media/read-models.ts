/**
 * The media side of read models (S5-01, PATTERNS §14) for the search worker (PATTERNS §12 "Cross-module functions
 * for workers"): raw `tx` (`withSystem`), no authorization, never called from request code. Public variant keys
 * only (`variantKey`: an HMAC of the hash, never the hash); documents never appear.
 */
import type { ListingRoomType, ReadModelImage, ReadModelMedia, VideoProvider } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import * as repo from './repo';
import { variantKey, variantsIn } from './variants';

export interface ReadModelMediaSet {
  /** Display order; processed images and floor plans, and video links. */
  items: ReadModelMedia[];
  /** Images still processing (not shown yet): the builder looks again later. */
  pending: number;
}

/**
 * These listings' shown media, by listing id (a listing without media is missing). One statement. `agencyId`
 * (S11-F3): only that agency's media rows — an explicit predicate for a caller reading one agency as `app_system`.
 */
export async function mediaForReadModels(
  tx: Tx,
  listingIds: readonly string[],
  opts: { agencyId?: string } = {},
): Promise<Map<string, ReadModelMediaSet>> {
  const out = new Map<string, ReadModelMediaSet>();
  for (const row of await repo.readModelMedia(tx, listingIds, opts.agencyId)) {
    let set = out.get(row.propertyId);
    if (!set) {
      set = { items: [], pending: 0 };
      out.set(row.propertyId, set);
    }
    if (row.kind === 'VIDEO') {
      if (row.videoProvider && row.videoId) {
        set.items.push({ kind: 'VIDEO', provider: row.videoProvider as VideoProvider, id: row.videoId });
      }
      continue;
    }
    const sizes = variantsIn(row.variantsReady ?? 0);
    if (
      row.sha256 === null ||
      row.pipeline === null ||
      row.width === null ||
      row.height === null ||
      sizes.length === 0
    ) {
      // Unprocessed: shown once processed. A failed one never will be.
      if (row.failedAt === null) set.pending += 1;
      continue;
    }
    const { sha256, pipeline } = row;
    const image: ReadModelImage = {
      kind: row.kind as ReadModelImage['kind'],
      cover: row.isCover,
      alt: row.altText,
      room: row.roomType as ListingRoomType | null,
      width: row.width,
      height: row.height,
      variants: Object.fromEntries(sizes.map((s) => [s, variantKey(sha256, s, pipeline)])),
    };
    set.items.push(image);
  }
  return out;
}
