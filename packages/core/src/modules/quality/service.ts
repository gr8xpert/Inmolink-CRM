/**
 * quality use cases (PATTERNS §7, S3-08): the listing quality score with fix-it hints. The editor asks for the
 * live score (`getListingQuality`); the worker stores it on the listing after each change
 * (`recomputeListingQuality`, `quality.recomputeListing`) for ranking and lists. Both score the same facts with
 * `scoreListing`. No tables of its own: the facts come from properties, media and agencies.
 */
import type { ListingQualityDto } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as agencies from '../agencies';
import * as media from '../media';
import * as properties from '../properties';
import { assertCan } from './policy';
import { type QualityResult, scoreListing } from './score';

async function scoreOf(
  tx: Tx,
  inputs: properties.ListingQualityInputs,
  listingId: string,
  locales: readonly string[],
): Promise<QualityResult> {
  return scoreListing({
    images: await media.listingImageSizes(tx, listingId),
    descriptions: inputs.descriptions,
    locales,
    status: inputs.status,
    hasCoordinates: inputs.hasCoordinates,
    locationPrecision: inputs.locationPrecision,
    energyRating: inputs.energyRating,
    lastConfirmedAt: inputs.lastConfirmedAt,
    networkHiddenAt: inputs.networkHiddenAt,
    now: clock.now(),
  });
}

/**
 * `GET /v1/listings/:id/quality`: the agency's own listing's score, computed now (so a change shows at once, not
 * after the worker), with its parts and fix-it hints, biggest gain first. Another agency's listing is FORBIDDEN,
 * one the caller cannot see LISTING_NOT_FOUND. Three reads (listing, translations, photos).
 */
export async function getListingQuality(ctx: Ctx, listingId: string): Promise<ListingQualityDto> {
  assertCan(ctx, 'quality.read');
  const inputs = await properties.listingQualityInputs(ctx.tx, listingId);
  if (!inputs) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'quality.read', { agencyId: inputs.agencyId });
  return { listingId, ...(await scoreOf(ctx.tx, inputs, listingId, ctx.tenant.locales)) };
}

/**
 * Worker (`quality.recomputeListing`): scores the listing in its agency's tenant transaction and stores the score
 * when it changed. Null when the listing is gone or not the agency's. Idempotent.
 */
export async function recomputeListingQuality(
  tx: Tx,
  agencyId: string,
  listingId: string,
): Promise<{ score: number; changed: boolean; pendingPhotos: number } | null> {
  const inputs = await properties.listingQualityInputs(tx, listingId);
  // Only the agency's own listing (RLS also shows other agencies' shared ones, which it may not write).
  if (!inputs || inputs.agencyId !== agencyId) return null;
  const tenant = await agencies.loadTenant(tx, inputs.agencyId);
  const result = await scoreOf(tx, inputs, listingId, tenant?.locales ?? []);
  const changed = await properties.setListingQualityScore(tx, listingId, result.score);
  return { score: result.score, changed, pendingPhotos: result.pendingPhotos };
}
