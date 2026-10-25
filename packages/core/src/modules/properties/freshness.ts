/**
 * Listing freshness and the quality score's listing side (S3-08, PLAN §7 M2, §10). A listing is confirmed as
 * still on the market when created, with the confirm button, and when it goes ACTIVE again. The hourly sweep
 * (`properties.sweepFreshness`) prompts the agent 90 days after the last confirmation and hides the listing from
 * the network at 120 (`network_hidden_at`, in the RLS network predicate) — the owner keeps seeing and editing it,
 * and a confirmation brings it back.
 */
import {
  type CeeRating,
  LISTING_CONFIRM_PROMPT_DAYS,
  LISTING_NETWORK_HIDE_DAYS,
  type ListingDto,
  type ListingStatus,
  type LocationPrecision,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { propertiesEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';
import { daysAfter, ownForChange, reconfirmed, toDto } from './service';

/**
 * `POST /v1/listings/:id/confirm`: the listing is still on the market. Same rights as an edit. No `version`: a
 * confirmation overwrites nothing and is safe to repeat, and the sweep may have bumped the version the editor holds
 * (the row lock orders it after any concurrent change). A listing the sweep hid is back on the network at once.
 */
export async function confirmListing(ctx: Ctx, id: string): Promise<ListingDto> {
  const current = await ownForChange(ctx, id, 'listing.update');
  if (current.deletedAt) throw new AppError('LISTING_NOT_FOUND');
  assertCan(ctx, 'listing.update', current);
  const updated = await repo.updateWithVersion(ctx.tx, id, current.version, reconfirmed());
  if (!updated) throw new AppError('VERSION_CONFLICT');
  const base = { listingId: id, agencyId: updated.agencyId, version: updated.version };
  const events: OutboxMessage[] = [propertiesEvents.updated({ ...base, changed: ['freshness'] })];
  if (current.networkHiddenAt) {
    events.push(
      propertiesEvents.visibilityChanged({ ...base, visibility: updated.visibility, shareScope: updated.shareScope }),
    );
  }
  await emit(ctx.tx, events);
  return toDto(ctx, updated, await repo.getPrivates(ctx.tx, id));
}

/**
 * One batch of the freshness sweep (all agencies, `withSystem`): hides the listings unconfirmed for 120 days from
 * the network, then marks those unconfirmed for 90 as prompted, ≤ `batch` each, with their events in the same
 * transaction. Idempotent: a row already hidden or prompted is not selected again until it is confirmed.
 */
export async function sweepFreshnessBatch(
  tx: Tx,
  now: Date,
  batch: number,
): Promise<{ hidden: number; prompted: number }> {
  const hidden = await repo.hideFromNetwork(tx, daysAfter(now, -LISTING_NETWORK_HIDE_DAYS), batch);
  const prompted = await repo.markConfirmPrompted(tx, daysAfter(now, -LISTING_CONFIRM_PROMPT_DAYS), batch);
  const events: OutboxMessage[] = [];
  for (const r of hidden) {
    if (r.visibility === 'PRIVATE') continue; // never on the network: nothing changed for anyone
    const base = { listingId: r.id, agencyId: r.agencyId, version: r.version };
    events.push(
      propertiesEvents.updated({ ...base, changed: ['freshness'] }),
      propertiesEvents.visibilityChanged({
        ...base,
        visibility: r.visibility,
        shareScope: r.shareScope,
        networkHidden: true,
      }),
    );
  }
  for (const r of prompted) {
    events.push(propertiesEvents.confirmationDue({ listingId: r.id, agencyId: r.agencyId, version: r.version }));
  }
  await emit(tx, events);
  return { hidden: hidden.length, prompted: prompted.length };
}

/** What the quality module scores of a listing (S3-08). */
export interface ListingQualityInputs {
  agencyId: string;
  status: ListingStatus;
  energyRating: CeeRating | null;
  hasCoordinates: boolean;
  locationPrecision: LocationPrecision;
  lastConfirmedAt: Date;
  networkHiddenAt: Date | null;
  qualityScore: number | null;
  /** Description length (characters) per translated locale. */
  descriptions: { locale: string; length: number }[];
}

/**
 * For the quality module: a listing's scored fields, as `tx` sees it (request: RLS; worker: the owner agency's
 * tenant transaction). Null when it does not exist or is not visible. Two primary-key reads.
 */
export async function listingQualityInputs(tx: Tx, id: string): Promise<ListingQualityInputs | null> {
  const row = await repo.qualityRow(tx, id);
  if (!row) return null;
  return {
    agencyId: row.agencyId,
    status: row.status,
    energyRating: row.energyRating,
    hasCoordinates: row.lat !== null,
    locationPrecision: row.locationPrecision,
    lastConfirmedAt: row.lastConfirmedAt,
    networkHiddenAt: row.networkHiddenAt,
    qualityScore: row.qualityScore,
    descriptions: await repo.descriptionLengths(tx, id),
  };
}

/**
 * `listingQualityInputs` for a batch (S6-F3, the quality queue): the listings `tx` sees, by id. Two statements for any
 * number.
 */
export async function listingsQualityInputs(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, ListingQualityInputs>> {
  const unique = [...new Set(ids)];
  const [rows, lengths] = [await repo.qualityRows(tx, unique), await repo.descriptionLengthsOf(tx, unique)];
  const descriptions = new Map<string, { locale: string; length: number }[]>();
  for (const { propertyId, locale, length } of lengths) {
    const list = descriptions.get(propertyId) ?? [];
    list.push({ locale, length });
    descriptions.set(propertyId, list);
  }
  return new Map(
    rows.map((row) => [
      row.id,
      {
        agencyId: row.agencyId,
        status: row.status,
        energyRating: row.energyRating,
        hasCoordinates: row.lat !== null,
        locationPrecision: row.locationPrecision,
        lastConfirmedAt: row.lastConfirmedAt,
        networkHiddenAt: row.networkHiddenAt,
        qualityScore: row.qualityScore,
        descriptions: descriptions.get(row.id) ?? [],
      },
    ]),
  );
}

/** For the quality module's batches: stores recomputed scores (one statement); answers the listings that changed. */
export function setListingQualityScores(tx: Tx, scores: readonly { id: string; score: number }[]): Promise<string[]> {
  return repo.setQualityScores(tx, scores);
}

/** For the quality module's worker job: stores a recomputed score; true when it changed. */
export function setListingQualityScore(tx: Tx, id: string, score: number): Promise<boolean> {
  return repo.setQualityScore(tx, id, score);
}
