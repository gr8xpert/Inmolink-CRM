/**
 * The listing side of read models (S5-01, PATTERNS §14) for the search worker (PATTERNS §12 "Cross-module functions
 * for workers"): raw `tx` (`withSystem`), no authorization — the caller's `withSystem` reason is the audit — and
 * never called from request code. Only client-safe columns leave this module here: no privates, commission,
 * split, owner, tags or feed references.
 */
import type { Tx } from '@inmolink/db';
import { type SQL, sql } from 'drizzle-orm';
import * as repo from './repo';

/** Statuses a public path may show (DRAFT and WITHDRAWN never have a read model). */
export const READ_MODEL_LISTING_STATUSES = ['ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED'] as const;

/**
 * A listing has a read model when it is live, not PRIVATE, in a showable status, and — when SHARED — not hidden from
 * the network for going unconfirmed (S3-08; a PUBLIC one stays on its owner's channels). The one rule: loads, the
 * full rebuild's walk and its count all use it. Hiding and confirming emit `properties.listing.updated`.
 */
const HAS_READ_MODEL: SQL = sql.raw(
  `deleted_at is null and visibility <> 'PRIVATE' and status in (${READ_MODEL_LISTING_STATUSES.map((s) => `'${s}'`).join(', ')})
   and not (visibility = 'SHARED' and network_hidden_at is not null)`,
);

export interface ReadModelListing {
  id: string;
  agencyId: string;
  ref: string;
  status: repo.ReadModelRow['status'];
  visibility: repo.ReadModelRow['visibility'];
  transactionType: repo.ReadModelRow['transactionType'];
  priceCents: number | null;
  currency: string;
  pricePeriod: repo.ReadModelRow['pricePeriod'];
  priceOnRequest: boolean;
  builtM2: number | null;
  plotM2: number | null;
  terraceM2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  yearBuilt: number | null;
  energyRating: repo.ReadModelRow['energyRating'];
  energyEmissionsRating: repo.ReadModelRow['energyEmissionsRating'];
  /** The shown point (never the private pin). */
  lat: number | null;
  lng: number | null;
  locationPrecision: repo.ReadModelRow['locationPrecision'];
  propertyTypeId: string;
  locationId: string;
  developmentId: string | null;
  version: number;
  translations: {
    locale: string;
    title: string;
    description: string | null;
    slug: string;
    metaTitle: string | null;
    metaDescription: string | null;
  }[];
  featureIds: string[];
}

const num = (v: string | null) => (v === null ? null : Number(v));

/**
 * These listings as read models show them, for the ones that have one; a listing missing from the answer has none
 * (gone, deleted, PRIVATE, DRAFT, WITHDRAWN, or SHARED and hidden from the network) and its read models are dropped. Three statements for any number.
 */
export async function listingsForReadModels(tx: Tx, ids: readonly string[]): Promise<ReadModelListing[]> {
  const rows = await repo.readModelRows(tx, ids, HAS_READ_MODEL);
  if (rows.length === 0) return [];
  const live = rows.map((r) => r.id);
  const [translations, features] = await Promise.all([
    repo.readModelTranslations(tx, live),
    repo.readModelFeatures(tx, live),
  ]);
  const textsOf = new Map<string, ReadModelListing['translations']>();
  for (const { propertyId, ...t } of translations) {
    const list = textsOf.get(propertyId) ?? [];
    list.push(t);
    textsOf.set(propertyId, list);
  }
  const featuresOf = new Map<string, string[]>();
  for (const f of features) {
    const list = featuresOf.get(f.propertyId) ?? [];
    list.push(f.featureId);
    featuresOf.set(f.propertyId, list);
  }
  return rows.map((r) => ({
    ...r,
    builtM2: num(r.builtM2),
    plotM2: num(r.plotM2),
    terraceM2: num(r.terraceM2),
    lat: num(r.lat),
    lng: num(r.lng),
    translations: textsOf.get(r.id) ?? [],
    featureIds: (featuresOf.get(r.id) ?? []).sort(),
  }));
}

/** The full rebuild's progress: how many listings have a read model (one agency's, or all). */
export function countListingsForReadModels(tx: Tx, agencyId?: string): Promise<number> {
  return repo.countWhere(tx, HAS_READ_MODEL, agencyId);
}

/** The full rebuild (`pnpm ops:rebuild-read-models`): ids of listings that have a read model, by id, a page at a time. */
export function listingIdsForReadModels(
  tx: Tx,
  page: { after: string | null; limit: number; agencyId?: string },
): Promise<string[]> {
  return repo.readModelIdsPage(tx, HAS_READ_MODEL, page);
}
