/**
 * Feed imports into listings (S6-02, PATTERNS §13, PLAN §3 #18): the bulk write the imports loader calls inside a
 * feed run's fenced batch transaction (`withTenant`, the agency's RLS). Functions for the imports worker (PATTERNS
 * §12 "Cross-module functions for workers"): they take the raw `tx` and no `ctx` — there is no member acting, the run
 * is the authority — and are never called from request code.
 *
 * One batch: COPY the items into a staging table, match them to the agency's listings by (source, feed reference),
 * then one MERGE writes what changed — an item whose import hash (its values and resolved taxonomy ids) is unchanged
 * writes nothing and emits nothing. Children (privates, translations, features, histories) follow set-based, and one
 * `properties.listings.imported` event per 250 changed listings is inserted in one statement. A fixed handful of
 * statements per batch, whatever its size.
 */
import type { Commission, LocationPrecision } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import * as taxonomy from '../taxonomy';
import { slugOf } from './content';
import { IMPORTED_PER_EVENT, propertiesEvents } from './events';
import * as repo from './import-repo';
import { newRef, shownPoint } from './service';

/** Why an imported listing is held as DRAFT: a taxonomy value of this kind has no confident match yet (S2-05 queue). */
export type ImportHold = 'location' | 'propertyType' | 'feature';

/** One feed item, resolved by the imports loader (taxonomy ids, hash); the listing it becomes or updates. */
export interface ImportListing {
  /** The feed's reference: the re-import key with the run's source. */
  ref: string;
  /** SHA-256 (hex) of everything below as resolved: unchanged → the listing is not written. */
  hash: string;
  /** SHA-256 of the image URLs in order; null without images. */
  imagesHash: string | null;
  held: readonly ImportHold[];
  status: 'ACTIVE' | 'UNDER_OFFER' | 'SOLD' | 'RENTED';
  transactionType: 'SALE' | 'RENT_LONG_TERM' | 'RENT_SHORT_TERM';
  priceCents: number | null;
  currency: string;
  pricePeriod: 'NIGHT' | 'WEEK' | 'MONTH' | null;
  priceOnRequest: boolean;
  builtM2: number | null;
  plotM2: number | null;
  terraceM2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  yearBuilt: number | null;
  energyRating: string | null;
  energyEmissionsRating: string | null;
  /** The exact pin (private); the shown point is derived like a manual listing's. */
  coordinates: { lat: number; lng: number } | null;
  locationPrecision: LocationPrecision;
  /** Null when unmatched: a new listing cannot be stored, an existing one keeps its own. */
  propertyTypeId: string | null;
  /** The deepest matched level (held when a lower one is unmatched); null when none matched. */
  locationId: string | null;
  featureIds: readonly string[];
  translations: readonly { locale: string; title: string; description: string | null }[];
}

/** The run a batch belongs to, and what a new listing gets. */
export interface ImportRun {
  agencyId: string;
  runId: string;
  connectionId: string;
  /**
   * `properties.source` (the connector's format, `KYERO`). Feed references are matched per connection
   * (`property_privates.external_source` = `KYERO:<connection id>`): two feeds of one format never share listings.
   */
  source: string;
  /** The member new listings belong to. */
  ownerUserId: string;
  /** The agency's default commission and split (PLAN §3 #7), for new listings only. */
  commission: Commission;
  splitBp: number;
}

export interface ImportBatchResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Stored listings of the batch held as DRAFT. */
  held: number;
  /**
   * Items that were not stored, per-item errors of the run: new items with no type or no location level matched,
   * and items whose reference an earlier batch of the run already had (`DUPLICATE_REF`, S7-F2: the first wins).
   */
  rejected: { ref: string; code: 'PROPERTY_TYPE_UNMATCHED' | 'LOCATION_UNMATCHED' | 'DUPLICATE_REF' }[];
  /** Listings created or updated whose image list is new or changed: their feed images are queued (media). */
  imagesChanged: { listingId: string; ref: string }[];
  /** S7-F3: seen references this batch recorded (the run keeps the count on its logged row). */
  seen: number;
}

const decimal = (v: number | null) => (v === null ? null : String(v));

function stagingRow(
  item: ImportListing,
  levels: Map<number, string> | undefined,
  freshRef: string,
  existing: repo.ExistingImport | undefined,
): repo.StagingRow {
  const shown = shownPoint(item.coordinates, item.locationPrecision);
  return {
    ref: item.ref,
    hash: item.hash,
    images_hash: item.imagesHash,
    held: item.held,
    status: item.status,
    transaction_type: item.transactionType,
    price_cents: item.priceCents,
    currency: item.currency,
    price_period: item.transactionType === 'SALE' ? null : item.pricePeriod,
    price_on_request: item.priceOnRequest,
    built_m2: decimal(item.builtM2),
    plot_m2: decimal(item.plotM2),
    terrace_m2: decimal(item.terraceM2),
    bedrooms: item.bedrooms,
    bathrooms: item.bathrooms,
    year_built: item.yearBuilt,
    energy_rating: item.energyRating,
    energy_emissions_rating: item.energyEmissionsRating,
    lat: shown.lat,
    lng: shown.lng,
    exact_lat: item.coordinates ? String(item.coordinates.lat) : null,
    exact_lng: item.coordinates ? String(item.coordinates.lng) : null,
    location_precision: item.locationPrecision,
    property_type_id: item.propertyTypeId,
    location_id: item.locationId,
    country_id: levels?.get(1) ?? null,
    region_id: levels?.get(2) ?? null,
    city_id: levels?.get(3) ?? null,
    feature_ids: item.featureIds,
    translations: item.translations.map((t) => ({ ...t, slug: slugOf(t.title) })),
    new_id: newId(),
    new_ref: freshRef,
    existing_id: existing?.id ?? null,
    live: existing?.live ?? false,
    old_hash: existing?.hash ?? null,
    old_images_hash: existing?.imagesHash ?? null,
    old_missed: existing?.missed ?? 0,
    old_withdrawn: existing?.withdrawn ?? false,
    old_conn: existing?.connectionId ?? null,
  };
}

/** `count` distinct new references. */
function freshRefs(count: number): string[] {
  const refs = new Set<string>();
  while (refs.size < count) refs.add(newRef());
  return [...refs];
}

async function emitImported(tx: Tx, run: Pick<ImportRun, 'agencyId' | 'runId'>, ids: readonly string[]) {
  const messages = [];
  for (let i = 0; i < ids.length; i += IMPORTED_PER_EVENT) {
    messages.push(
      propertiesEvents.imported({
        agencyId: run.agencyId,
        runId: run.runId,
        listingIds: ids.slice(i, i + IMPORTED_PER_EVENT),
      }),
    );
  }
  await emit(tx, messages); // one INSERT for the whole batch
}

/**
 * Imports one batch of a feed run (S6-02). `seenRefs`: references of the batch's failed items, counted as present in
 * the feed (a typo in a feed never withdraws a listing). References are unique within `items` (the loader checks);
 * one already seen by an earlier batch of the run is refused as `DUPLICATE_REF` (S7-F2): the feed's first item with a
 * reference is the one imported, so a listing is never written twice by one run and `updated` is not inflated.
 */
export async function importListingBatch(
  tx: Tx,
  run: ImportRun,
  batch: readonly ImportListing[],
  seenRefs: readonly string[] = [],
): Promise<ImportBatchResult> {
  const scope: repo.ImportScope = {
    batchId: newId(),
    agencyId: run.agencyId,
    runId: run.runId,
    connectionId: run.connectionId,
    source: run.source,
    externalSource: `${run.source}:${run.connectionId}`,
  };
  const empty: ImportBatchResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    held: 0,
    rejected: [],
    imagesChanged: [],
    seen: 0,
  };
  // S7-F2: duplicates across batches — one primary-key probe per batch, nothing held in memory between batches.
  const refsOfBatch = batch.map((i) => i.ref);
  const earlier = new Set(await repo.seenEarlier(tx, run.runId, refsOfBatch));
  const duplicates = batch
    .filter((i) => earlier.has(i.ref))
    .map((i) => ({ ref: i.ref, code: 'DUPLICATE_REF' as const }));
  const items = earlier.size === 0 ? batch : batch.filter((i) => !earlier.has(i.ref));
  if (items.length === 0) {
    const seen = seenRefs.length > 0 ? await repo.recordSeen(tx, scope, seenRefs) : 0;
    return { ...empty, rejected: duplicates, seen };
  }

  const locationIds = [...new Set(items.flatMap((i) => (i.locationId ? [i.locationId] : [])))];
  const lineages = await taxonomy.locationLineages(tx, locationIds);
  const existing = new Map(
    (
      await repo.existingByRefs(
        tx,
        scope,
        items.map((i) => i.ref),
      )
    ).map((e) => [e.ref, e]),
  );
  // Random references a listing of the agency has already: practically never; drawn again until none collides.
  const refs = freshRefs(items.length);
  for (let taken = await repo.takenRefs(tx, run.agencyId, refs); taken.length > 0; ) {
    const used = new Set(refs);
    for (const ref of taken) {
      let next = newRef();
      while (used.has(next)) next = newRef();
      used.add(next);
      refs[refs.indexOf(ref)] = next;
    }
    taken = await repo.takenRefs(tx, run.agencyId, refs);
  }
  await repo.stage(
    tx,
    scope,
    items.map((item, i) =>
      stagingRow(
        item,
        item.locationId ? lineages.get(item.locationId) : undefined,
        refs[i] as string,
        existing.get(item.ref),
      ),
    ),
  );
  const seen = await repo.recordSeen(tx, scope, seenRefs);
  const rejectedRows = await repo.rejectUnplaceable(tx, scope);
  const commission =
    run.commission.type === 'PCT'
      ? { commissionBp: run.commission.basisPoints, commissionFixedCents: null }
      : { commissionBp: null, commissionFixedCents: run.commission.amount.amountCents };
  const merged = await repo.mergeListings(tx, scope, {
    userId: run.ownerUserId,
    ...commission,
    includesVat: run.commission.includesVat,
    splitBp: run.splitBp,
  });
  await repo.writePrivates(tx, scope);
  const changedIds = merged.map((m) => m.id);
  const featuresOf = new Map(items.map((i) => [i.ref, i.featureIds]));
  const pairs = { listingIds: [] as string[], featureIds: [] as string[] };
  for (const m of merged) {
    for (const f of featuresOf.get(m.ref) ?? []) {
      pairs.listingIds.push(m.id);
      pairs.featureIds.push(f);
    }
  }
  await repo.writeContent(tx, scope, changedIds, pairs);

  const statuses: repo.StatusHistoryInsert[] = [];
  const prices: repo.PriceHistoryInsert[] = [];
  for (const m of merged) {
    if (m.oldStatus !== m.newStatus) {
      statuses.push({
        id: newId(),
        propertyId: m.id,
        agencyId: run.agencyId,
        fromStatus: (m.oldStatus as repo.StatusHistoryInsert['fromStatus']) ?? null,
        toStatus: m.newStatus as repo.StatusHistoryInsert['toStatus'],
        changedByUserId: null,
      });
    }
    const before = m.oldPriceCents === null ? null : Number(m.oldPriceCents);
    const after = m.newPriceCents === null ? null : Number(m.newPriceCents);
    if (before !== after && !(m.action === 'INSERT' && after === null)) {
      prices.push({
        id: newId(),
        propertyId: m.id,
        agencyId: run.agencyId,
        previousPriceCents: before,
        priceCents: after,
        currency: m.currency,
        changedByUserId: null,
      });
    }
  }
  await repo.insertHistories(tx, statuses, prices);
  await emitImported(tx, run, changedIds);
  await repo.unstage(tx, scope);

  const rejected = new Set(rejectedRows.map((r) => r.ref));
  const created = merged.filter((m) => m.action === 'INSERT').length;
  const updated = merged.length - created;
  const stored = items.length - rejected.size;
  return {
    seen,
    created,
    updated,
    unchanged: stored - merged.length,
    held: items.filter((i) => i.held.length > 0 && !rejected.has(i.ref)).length,
    rejected: [
      ...duplicates,
      ...rejectedRows.map((r) => ({
        ref: r.ref,
        code: r.noType ? ('PROPERTY_TYPE_UNMATCHED' as const) : ('LOCATION_UNMATCHED' as const),
      })),
    ],
    imagesChanged: merged.filter((m) => m.imagesChanged).map((m) => ({ listingId: m.id, ref: m.ref })),
  };
}

/**
 * The end of a successful run (S6-02): the connection's listings missing from it count one more missed run; at
 * `afterMissedRuns` in a row a listing is WITHDRAWN (not a sold, rented or status-locked one), with its status
 * history and one event per 250. Then the run's seen references go. Answers how many were withdrawn.
 */
export async function withdrawMissingImports(
  tx: Tx,
  run: Pick<ImportRun, 'agencyId' | 'runId' | 'connectionId'>,
  afterMissedRuns: number,
  /** From `importDropStats` in this transaction (S6-08): the run-end EXCEPT is not run twice. */
  missingRefs?: readonly string[],
): Promise<number> {
  if (!Number.isInteger(afterMissedRuns) || afterMissedRuns < 1) {
    throw new TypeError('withdrawMissingImports: afterMissedRuns must be a positive integer');
  }
  const due = await repo.countMisses(tx, run, afterMissedRuns, missingRefs);
  const withdrawn = await repo.withdraw(tx, run.agencyId, due);
  await repo.insertHistories(
    tx,
    withdrawn.map((w) => ({
      id: newId(),
      propertyId: w.id,
      agencyId: run.agencyId,
      fromStatus: w.fromStatus as repo.StatusHistoryInsert['fromStatus'],
      toStatus: 'WITHDRAWN',
      changedByUserId: null,
    })),
    [],
  );
  await emitImported(
    tx,
    run,
    withdrawn.map((w) => w.id),
  );
  await repo.deleteSeen(tx, run.runId);
  return withdrawn.length;
}

/**
 * The anomaly guard's counts for a finishing run (S6-08): live listings of the connection (in the previous run,
 * created before `runStartedAt`), how many of them this run missed, and every missing reference (pass them to
 * `withdrawMissingImports` in the same transaction).
 */
export function importDropStats(
  tx: Tx,
  run: Pick<ImportRun, 'agencyId' | 'runId' | 'connectionId'>,
  runStartedAt: Date,
): Promise<{ live: number; missing: number; refs: string[] }> {
  return repo.dropStats(tx, run, runStartedAt);
}

/**
 * Freshness via feed (S6-08, user-approved 2026-10-19), step 1: the connection's listings present in its last run and
 * last confirmed before `before`. Call after the run's end committed, then confirm them in batches.
 */
export function listingsToConfirmFromFeed(
  tx: Tx,
  run: Pick<ImportRun, 'agencyId' | 'connectionId'>,
  before: Date,
): Promise<string[]> {
  return repo.freshCandidates(tx, run, before);
}

/** Ids per `confirmListingsFromFeed` call (one short transaction each). */
export const FEED_CONFIRM_BATCH = 1_000;

/**
 * Freshness via feed, step 2: these listings (≤ `FEED_CONFIRM_BATCH`) count as confirmed still on the market (S3-08),
 * as the confirm button does. Listings whose confirmation prompt or network hide is cleared emit
 * `properties.listings.imported` (search and quality rebuild them). Idempotent. Answers how many were confirmed.
 */
export async function confirmListingsFromFeed(
  tx: Tx,
  run: Pick<ImportRun, 'agencyId' | 'runId'>,
  ids: readonly string[],
  before: Date,
): Promise<number> {
  const { confirmed, cleared } = await repo.confirmFresh(tx, run.agencyId, ids, before);
  await emitImported(tx, run, cleared);
  return confirmed;
}

/** Seen references the run has now (S7-F3: the loader checks them against the run's logged count). */
export function countImportSeen(tx: Tx, runId: string): Promise<number> {
  return repo.countSeen(tx, runId);
}

/** A run that ends without withdrawals (failed, or a feed with nothing valid): its seen references go. */
export function discardImportSeen(tx: Tx, runId: string): Promise<void> {
  return repo.deleteSeen(tx, runId);
}

/** Seen references a crashed run left (older than `before`), `limit` per statement (`imports.pruneRuns`). */
export function pruneImportSeen(tx: Tx, before: Date, limit: number): Promise<number> {
  return repo.pruneSeen(tx, before, limit);
}

/** The agency's live listings among `ids`, row-locked: the media worker attaches feed images to these only. */
export function lockListingsForFeedImages(tx: Tx, agencyId: string, ids: readonly string[]): Promise<string[]> {
  return repo.lockLive(tx, agencyId, ids);
}

/**
 * Which of these feed references a connection has imported already (live listings only): the mapper's dry run
 * reports them as "would update", the others as "would create". Read-only, one statement for the whole list.
 */
export async function existingImportRefs(
  tx: Tx,
  scope: { agencyId: string; source: string; connectionId: string },
  refs: readonly string[],
): Promise<Set<string>> {
  const rows = await repo.existingByRefs(
    tx,
    { agencyId: scope.agencyId, externalSource: `${scope.source}:${scope.connectionId}` },
    refs,
  );
  return new Set(rows.filter((r) => r.live).map((r) => r.ref));
}
