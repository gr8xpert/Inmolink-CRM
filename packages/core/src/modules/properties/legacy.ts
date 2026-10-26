/**
 * Legacy listings (S14-02, PLAN §14, ADR 0006): one batch of a legacy agency's listings through the feed import's bulk
 * path (S6-02: staging table → one MERGE → children set-based), so a batch is a fixed handful of statements whatever its
 * size and an unchanged listing writes nothing. What differs from a feed run:
 *
 * - the re-import key is the legacy id (`property_privates.external_source = 'LEGACY'`, `external_ref` = legacy id), and
 *   the listing keeps its legacy reference (`properties.ref`) unless another listing of the agency holds it;
 * - each new listing belongs to its legacy agent (the member that user became) and records `properties.legacy_id`;
 * - there is no feed connection and no run: no seen references, no withdrawal of missing listings.
 *
 * The caller is the operator's load script (`withSystem()`): no member acts, so no policy check (as a feed run).
 */
import { createHash } from 'node:crypto';
import type { Commission } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import * as taxonomy from '../taxonomy';
import * as repo from './import-repo';
import { emitImported, type ImportListing, stagingRow } from './imports';
import * as legacyRepo from './legacy-repo';
import { newRef } from './service';

/** `properties.source` and `property_privates.external_source` of migrated listings. */
export const LEGACY_SOURCE = 'LEGACY';

export interface LegacyListingInput extends Omit<ImportListing, 'ref' | 'hash' | 'imagesHash' | 'held'> {
  legacyId: string;
  /** The legacy reference, kept as the listing's own when free. */
  ref: string | null;
  /** The member the legacy agent became; null → the run's fallback owner. */
  ownerUserId: string | null;
  /** Image URLs in order (re-ingested by the media pipeline). */
  imageUrls: readonly string[];
}

export interface LegacyListingRun {
  agencyId: string;
  /** Owner of listings whose legacy agent is not a member (the agency's first admin). */
  fallbackOwnerUserId: string;
  /** The agency's default commission and split (PLAN §3 #7), for new listings. */
  commission: Commission;
  splitBp: number;
}

export interface LegacyListingsResult {
  /** Legacy id → listing id and what the batch did. */
  listings: Map<string, { id: string; outcome: 'created' | 'updated' | 'unchanged' }>;
  /** Not stored: a new listing without property type or location. */
  rejected: { legacyId: string; code: 'PROPERTY_TYPE_UNMATCHED' | 'LOCATION_UNMATCHED' }[];
  /** Listings whose image list is new or changed: queue these URLs (media). */
  imagesChanged: { listingId: string; urls: readonly string[] }[];
  /** Listings that kept no legacy reference (taken by another listing): legacy id → the new reference. */
  renamed: Map<string, string>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Everything the legacy row says (images included: a new image list re-queues them), so an unchanged row writes nothing. */
function hashOf(item: LegacyListingInput): string {
  const { legacyId: _l, ...rest } = item;
  return sha256(JSON.stringify(rest));
}

export async function importLegacyListingBatch(
  tx: Tx,
  run: LegacyListingRun,
  batch: readonly LegacyListingInput[],
): Promise<LegacyListingsResult> {
  const out: LegacyListingsResult = { listings: new Map(), rejected: [], imagesChanged: [], renamed: new Map() };
  const seen = new Set<string>();
  const items = batch.filter((i) => !seen.has(i.legacyId) && seen.add(i.legacyId));
  if (items.length === 0) return out;
  const batchId = newId();
  const scope: repo.ImportScope = {
    batchId,
    agencyId: run.agencyId,
    runId: batchId,
    connectionId: null,
    source: LEGACY_SOURCE,
    externalSource: LEGACY_SOURCE,
  };

  const locationIds = [...new Set(items.flatMap((i) => (i.locationId ? [i.locationId] : [])))];
  const lineages = await taxonomy.locationLineages(tx, locationIds);
  const existing = new Map(
    (
      await repo.existingByRefs(
        tx,
        scope,
        items.map((i) => i.legacyId),
      )
    ).map((e) => [e.ref, e]),
  );
  // New listings keep their legacy reference when no other listing of the agency has it.
  const fresh = items.filter((i) => !existing.has(i.legacyId));
  const wanted = fresh.map((i) => i.ref ?? newRef());
  const taken = new Set(
    await repo.takenRefs(
      tx,
      run.agencyId,
      wanted.filter((r): r is string => r !== null),
    ),
  );
  const used = new Set<string>();
  const refOf = new Map<string, string>();
  fresh.forEach((item, i) => {
    let ref = wanted[i] as string;
    if (taken.has(ref) || used.has(ref)) {
      // A random reference is practically never taken; it is checked by the unique index all the same.
      do ref = newRef();
      while (used.has(ref) || taken.has(ref));
      if (item.ref) out.renamed.set(item.legacyId, ref);
    }
    used.add(ref);
    refOf.set(item.legacyId, ref);
  });

  const imported = new Map<string, LegacyListingInput>();
  await repo.stage(
    tx,
    scope,
    items.map((item) => {
      imported.set(item.legacyId, item);
      const listing: ImportListing = {
        ...item,
        ref: item.legacyId,
        hash: hashOf(item),
        imagesHash: item.imageUrls.length > 0 ? sha256(item.imageUrls.join('\n')) : null,
        held: [],
      };
      return stagingRow(
        listing,
        item.locationId ? lineages.get(item.locationId) : undefined,
        refOf.get(item.legacyId) ?? newRef(),
        existing.get(item.legacyId),
      );
    }),
  );
  const rejectedRows = await repo.rejectUnplaceable(tx, scope);
  const commission =
    run.commission.type === 'PCT'
      ? { commissionBp: run.commission.basisPoints, commissionFixedCents: null }
      : { commissionBp: null, commissionFixedCents: run.commission.amount.amountCents };
  const merged = await repo.mergeListings(tx, scope, {
    userId: run.fallbackOwnerUserId,
    ...commission,
    includesVat: run.commission.includesVat,
    splitBp: run.splitBp,
    sendsCosts: false,
  });
  await repo.writePrivates(tx, scope);
  const changedIds = merged.map((m) => m.id);
  const pairs = { listingIds: [] as string[], featureIds: [] as string[] };
  for (const m of merged) {
    for (const f of imported.get(m.ref)?.featureIds ?? []) {
      pairs.listingIds.push(m.id);
      pairs.featureIds.push(f);
    }
  }
  await repo.writeContent(tx, scope, changedIds, pairs);
  // New listings: their legacy agent and legacy id (one statement).
  await legacyRepo.setLegacyOrigin(
    tx,
    run.agencyId,
    merged
      .filter((m) => m.action === 'INSERT')
      .map((m) => ({
        id: m.id,
        legacyId: m.ref,
        ownerUserId: imported.get(m.ref)?.ownerUserId ?? run.fallbackOwnerUserId,
      })),
  );

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
  await emitImported(tx, { agencyId: run.agencyId, runId: batchId }, changedIds);
  await repo.unstage(tx, scope);

  const rejected = new Set(rejectedRows.map((r) => r.ref));
  for (const r of rejectedRows) {
    out.rejected.push({ legacyId: r.ref, code: r.noType ? 'PROPERTY_TYPE_UNMATCHED' : 'LOCATION_UNMATCHED' });
  }
  const mergedOf = new Map(merged.map((m) => [m.ref, m]));
  for (const item of items) {
    if (rejected.has(item.legacyId)) continue;
    const m = mergedOf.get(item.legacyId);
    const id = m?.id ?? existing.get(item.legacyId)?.id;
    if (!id) continue;
    out.listings.set(item.legacyId, {
      id,
      outcome: !m ? 'unchanged' : m.action === 'INSERT' ? 'created' : 'updated',
    });
    if (m?.imagesChanged) out.imagesChanged.push({ listingId: id, urls: item.imageUrls });
  }
  return out;
}

export type { LegacyListingSnapshot } from './legacy-repo';

/**
 * S14-03: migrated listings as a validation compares them (status, transaction, price, sizes, taxonomy, feature ids).
 * The caller is the validation script (`withSystem()`); one statement for up to a few hundred ids.
 */
export function legacyListingSnapshots(
  tx: Tx,
  agencyId: string,
  ids: readonly string[],
): Promise<legacyRepo.LegacyListingSnapshot[]> {
  return legacyRepo.legacySnapshots(tx, agencyId, ids);
}

/**
 * S14-04 (delta sync): a page of the agency's migrated listings (`properties.legacy_id`), in legacy id order after
 * `after` — what the delta compares with the legacy ids still present. One statement.
 */
export function migratedListingsPage(
  tx: Tx,
  agencyId: string,
  after: string | null,
  limit: number,
): Promise<{ id: string; legacyId: string }[]> {
  return legacyRepo.migratedPage(tx, agencyId, after, Math.max(1, Math.min(limit, 5_000)));
}

/**
 * S14-04: withdraws these migrated listings, deleted in legacy during the parallel run — never a hard delete. As a
 * feed's missing listings (`import-repo.withdraw`): live and not sold, rented or withdrawn already, status not locked
 * by an agent; marked withdrawn by the import, so a legacy row that comes back re-lists the listing on the next
 * delta. Status history and `properties.listing.imported` (read models, search) in the same transaction.
 */
export async function withdrawLegacyListings(tx: Tx, agencyId: string, ids: readonly string[]): Promise<number> {
  const withdrawn = await repo.withdraw(tx, agencyId, ids);
  if (withdrawn.length === 0) return 0;
  await repo.insertHistories(
    tx,
    withdrawn.map((w) => ({
      id: newId(),
      propertyId: w.id,
      agencyId,
      fromStatus: w.fromStatus as repo.StatusHistoryInsert['fromStatus'],
      toStatus: 'WITHDRAWN',
      changedByUserId: null,
    })),
    [],
  );
  await emitImported(
    tx,
    { agencyId, runId: newId() },
    withdrawn.map((w) => w.id),
  );
  return withdrawn.length;
}
