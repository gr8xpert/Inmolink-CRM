/**
 * The new-build side of read models (S5-01, PATTERNS §14) for the search worker (PATTERNS §12 "Cross-module
 * functions for workers"): raw `tx` (`withSystem`), no authorization, never called from request code. Only
 * client-safe columns leave this module here: no commission, price lists, documents or access lists.
 */
import type { Tx } from '@inmolink/db';
import * as repo from './repo';

type UnitRow = Awaited<ReturnType<typeof repo.readModelUnits>>[number];

export interface ReadModelUnit {
  id: string;
  agencyId: string;
  developmentId: string;
  ref: string;
  status: UnitRow['status'];
  propertyTypeId: string;
  bedrooms: number | null;
  bathrooms: number | null;
  internalM2: number | null;
  terraceM2: number | null;
  plotM2: number | null;
  floor: number | null;
  orientation: UnitRow['orientation'];
  priceCents: number | null;
  currency: string;
  /** The unit's version plus its development's: grows when either changes. */
  version: number;
  development: {
    name: string;
    status: UnitRow['development']['status'];
    completionDate: string | null;
    locationId: string;
    lat: number | null;
    lng: number | null;
    /** OPEN developments are public; PRIVATE_NETWORK ones only reach the agencies they are shared with. */
    open: boolean;
    /** The agencies a PRIVATE_NETWORK development is shared with (network search, S5-05). */
    allowedAgencyIds: string[];
    translations: {
      locale: string;
      title: string;
      description: string | null;
      paymentTerms: string | null;
      slug: string;
      metaTitle: string | null;
      metaDescription: string | null;
    }[];
  };
  phase: { name: string; status: UnitRow['development']['status']; completionDate: string | null } | null;
}

const num = (v: string | null) => (v === null ? null : Number(v));

/**
 * These units as read models show them, for the ones that have one; a unit missing from the answer has none (gone,
 * or its development deleted) and its read models are dropped. Three statements for any number.
 */
export async function unitsForReadModels(tx: Tx, ids: readonly string[]): Promise<ReadModelUnit[]> {
  const rows = (await repo.readModelUnits(tx, ids)).filter((r) => r.development.deletedAt === null);
  if (rows.length === 0) return [];
  const developmentIds = [...new Set(rows.map((r) => r.developmentId))];
  const phaseIds = [...new Set(rows.flatMap((r) => (r.phaseId ? [r.phaseId] : [])))];
  const [texts, phases] = await Promise.all([
    repo.readModelDevelopmentTexts(tx, developmentIds),
    repo.readModelPhases(tx, phaseIds),
  ]);
  const textsOf = new Map<string, ReadModelUnit['development']['translations']>();
  for (const { developmentId, ...t } of texts) {
    const list = textsOf.get(developmentId) ?? [];
    list.push(t);
    textsOf.set(developmentId, list);
  }
  const phaseOf = new Map(phases.map(({ id, ...p }) => [id, p]));
  return rows.map((r) => ({
    id: r.id,
    agencyId: r.agencyId,
    developmentId: r.developmentId,
    ref: r.ref,
    status: r.status,
    propertyTypeId: r.propertyTypeId,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    internalM2: num(r.internalM2),
    terraceM2: num(r.terraceM2),
    plotM2: num(r.plotM2),
    floor: r.floor,
    orientation: r.orientation,
    priceCents: r.priceCents,
    currency: r.currency,
    version: r.version + r.development.version,
    development: {
      name: r.development.name,
      status: r.development.status,
      completionDate: r.development.completionDate,
      locationId: r.development.locationId,
      lat: num(r.development.lat),
      lng: num(r.development.lng),
      open: r.development.access === 'OPEN',
      allowedAgencyIds: r.allowedAgencyIds,
      translations: textsOf.get(r.developmentId) ?? [],
    },
    phase: (r.phaseId && phaseOf.get(r.phaseId)) || null,
  }));
}

/** The unit ids of a development (its change rebuilds them all). */
export function unitIdsForDevelopment(tx: Tx, developmentId: string): Promise<string[]> {
  return repo.unitIdsOf(tx, developmentId);
}

/**
 * For the overrides cleanup (S6-F1): the unit or development is gone — no unit row; no development row, or one of
 * `agencyId` that is soft-deleted. A live target, or another agency's, is not removed.
 */
export function isRemovedTarget(tx: Tx, kind: 'UNIT' | 'DEVELOPMENT', id: string, agencyId: string): Promise<boolean> {
  return repo.isRemoved(tx, kind, id, agencyId);
}

/** The full rebuild's progress: how many units have a read model (one agency's, or all). */
export function countUnitsForReadModels(tx: Tx, agencyId?: string): Promise<number> {
  return repo.countReadModelUnits(tx, agencyId);
}

/** The full rebuild (`pnpm ops:rebuild-read-models`): ids of units of live developments, by id, a page at a time. */
export function unitIdsForReadModels(
  tx: Tx,
  page: { after: string | null; limit: number; agencyId?: string },
): Promise<string[]> {
  return repo.readModelUnitIdsPage(tx, page);
}

/**
 * A unit's price and commission terms for the search index (S7-F4: a CUSTOM site's minimum commission on network
 * listings): the unit's own commission, else its development's. Read at index build time, never stored in a read model.
 */
export interface UnitCommissionTerms {
  id: string;
  priceCents: number | null;
  priceOnRequest: boolean;
  currency: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  /** The currency of `commissionFixedCents` (the unit's, or its development's when the development's applies). */
  commissionCurrency: string;
}

/** These units' commission terms: one statement. Worker-facing: raw `tx` under `withSystem`. */
export async function unitCommissionTerms(tx: Tx, ids: readonly string[]): Promise<UnitCommissionTerms[]> {
  const rows = await repo.commissionTermsOf(tx, ids);
  return rows.map((r) => {
    const own = r.unitCommissionBp !== null || r.unitCommissionFixedCents !== null;
    return {
      id: r.id,
      priceCents: r.priceCents,
      // Units have no on-request column: no price means price on request.
      priceOnRequest: r.priceCents === null,
      currency: r.currency,
      commissionBp: own ? r.unitCommissionBp : r.developmentCommissionBp,
      commissionFixedCents: own ? r.unitCommissionFixedCents : r.developmentCommissionFixedCents,
      // A fixed amount is in the currency of the row it comes from; the share compares it with the unit's price
      // currency (`commissionShareBp`: another currency is unknown, so a minimum excludes the unit).
      commissionCurrency: own ? r.currency : r.developmentCurrency,
    };
  });
}
