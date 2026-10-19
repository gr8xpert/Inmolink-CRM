/**
 * quality use cases (PATTERNS §7, S3-08): the listing quality score with fix-it hints. The editor asks for the
 * live score (`getListingQuality`); the worker stores it on the listing after each change
 * (`recomputeListingQuality`, `quality.recomputeListing`) for ranking and lists. Both score the same facts with
 * `scoreListing`. The facts come from properties, media and agencies; its one table is the recompute queue (S6-F3).
 */
import type { ListingQualityDto } from '@inmolink/contracts';
import { type Tx, withSystem, withTenant } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx } from '../../context';
import * as agencies from '../agencies';
import * as media from '../media';
import * as properties from '../properties';
import { assertCan } from './policy';
import * as repo from './repo';
import { type QualityResult, scoreListing } from './score';

/** The score of one listing's facts (pure). */
function scoreFrom(
  inputs: properties.ListingQualityInputs,
  images: readonly ({ width: number; height: number } | null)[],
  locales: readonly string[],
): QualityResult {
  return scoreListing({
    images: [...images],
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

async function scoreOf(
  tx: Tx,
  inputs: properties.ListingQualityInputs,
  listingId: string,
  locales: readonly string[],
): Promise<QualityResult> {
  return scoreFrom(inputs, await media.listingImageSizes(tx, listingId), locales);
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

export interface BatchRecomputeResult {
  /** Listings scored (the agency's own, still there). */
  scored: number;
  /** Listings whose stored score changed. */
  changed: string[];
  /** Listings with photos still processing: their resolution is not known yet (score again later). */
  pendingPhotos: string[];
}

/**
 * Worker (`quality.recomputeListings`, S6-F3): scores a batch of an agency's listings in its tenant transaction and
 * stores the scores that changed — about six statements for any number. Ids that are gone or another agency's are
 * skipped. Idempotent.
 */
export async function recomputeListingsQuality(
  tx: Tx,
  agencyId: string,
  listingIds: readonly string[],
): Promise<BatchRecomputeResult> {
  const inputs = await properties.listingsQualityInputs(tx, listingIds);
  // Only the agency's own listings (RLS also shows other agencies' shared ones, which it may not write).
  const own = [...inputs].filter(([, i]) => i.agencyId === agencyId);
  if (own.length === 0) return { scored: 0, changed: [], pendingPhotos: [] };
  const tenant = await agencies.loadTenant(tx, agencyId);
  const images = await media.listingsImageSizes(
    tx,
    own.map(([id]) => id),
  );
  const scored = own.map(([id, i]) => ({ id, result: scoreFrom(i, images.get(id) ?? [], tenant?.locales ?? []) }));
  const changed = await properties.setListingQualityScores(
    tx,
    scored.map((s) => ({ id: s.id, score: s.result.score })),
  );
  return {
    scored: scored.length,
    changed,
    pendingPhotos: scored.filter((s) => s.result.pendingPhotos > 0).map((s) => s.id),
  };
}

/** Queues recomputes (debounced by `delayMs`), outside any caller transaction (S6-F3). */
export function queueQualityRecomputes(changes: readonly repo.QualityChange[], delayMs: number): Promise<void> {
  return withSystem('quality.queueRecomputes', (tx) => repo.queueRecomputes(tx, changes, delayMs));
}

export interface QualityDrainOptions {
  /** Photos still processing: score again this much later, at most `maxRechecks` times. */
  recheckMs: number;
  maxRechecks: number;
  /** A claimed row is held this long; a recompute that died is retried after it. */
  leaseMs: number;
  /** Stop claiming after this long (the job's time box); what is left stays queued. */
  budgetMs: number;
  /** Wait in-process for listings due within this long (the tail of a burst) rather than queue a later run. */
  waitMs: number;
  batch?: number;
  signal?: AbortSignal;
}

export interface QualityDrainResult {
  scored: number;
  changed: number;
  /** Batches scored (each: a claim, a tenant transaction, a finish). */
  batches: number;
  /** Listings queued again for their photos. */
  rechecked: number;
  /** Milliseconds until the agency's next queued listing is due, or null when the queue holds none of it. */
  nextDueMs: number | null;
}

/** Listings scored per batch (S6-F3). */
export const QUALITY_BATCH = 250;

/**
 * Drains an agency's due quality recomputes (S6-F3, the S5-F4 shape): claims up to `batch` listings (system), scores
 * them in the agency's tenant transaction (RLS on), then reschedules photo rechecks and deletes the claimed rows
 * (system). A crash between the two leaves the rows claimed until the lease ends; they are scored again then
 * (idempotent). Repeats until nothing is due or the budget is spent.
 */
export async function drainQualityQueue(agencyId: string, options: QualityDrainOptions): Promise<QualityDrainResult> {
  const batch = options.batch ?? QUALITY_BATCH;
  const deadline = Date.now() + options.budgetMs;
  const total: QualityDrainResult = { scored: 0, changed: 0, batches: 0, rechecked: 0, nextDueMs: null };
  const reason = 'quality.recomputeListings';
  for (;;) {
    if (options.signal?.aborted || Date.now() >= deadline) break;
    const claim = await withSystem(reason, (tx) => repo.claimRecomputes(tx, agencyId, batch, options.leaseMs));
    if (claim.rows.length === 0) {
      const next = await withSystem(reason, (tx) => repo.nextRecomputeDue(tx, agencyId));
      // Due now but not claimable: another run holds them (or is claiming them) — it scores them; never spin.
      if (next === null || next <= 0 || next > options.waitMs || Date.now() + next >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.max(next, 0) + 10));
      continue;
    }
    try {
      const r = await withTenant({ agencyId }, (tx) =>
        recomputeListingsQuality(
          tx,
          agencyId,
          claim.rows.map((c) => c.listingId),
        ),
      );
      total.rechecked += await withSystem(reason, async (tx) => {
        const n = await repo.rescheduleRecomputes(tx, claim, r.pendingPhotos, options.maxRechecks, options.recheckMs);
        await repo.finishRecomputes(tx, claim);
        return n;
      });
      total.scored += r.scored;
      total.changed += r.changed.length;
      total.batches += 1;
    } catch (err) {
      // Pushed back a recheck period: a batch that keeps failing never pins the agency's oldest rows.
      await withSystem(reason, (tx) => repo.releaseRecomputes(tx, claim, options.recheckMs));
      throw err;
    }
  }
  total.nextDueMs = await withSystem(reason, (tx) => repo.nextRecomputeDue(tx, agencyId));
  return total;
}

/** Agencies whose queued recomputes are overdue and unclaimed (their job was lost). */
export function overdueQualityAgencies(overdueMs: number, limit: number): Promise<string[]> {
  return withSystem('quality.sweepQueue', (tx) => repo.overdueRecomputeAgencies(tx, overdueMs, limit));
}
