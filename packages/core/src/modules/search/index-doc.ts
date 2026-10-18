/**
 * The listings search index (S5-02, ADR 0005, PLAN §3 #16): one index, one document per listing or new-build unit,
 * built only from its `listing_read_models` rows (one per content locale). Localized text goes in per-locale fields
 * (`title_es`, `place_es`, `description_es`) and the query picks the request locale's; everything else is
 * locale-free ids and numbers for filters, facets and sorting. The index finds ids — results are hydrated from read
 * models — so it holds no client-facing field that would need white-labelling. Owner agency and share scope are
 * filter fields only (never displayed: `displayed` is the id).
 */
import { createHash } from 'node:crypto';
import type { ListingCardDoc, ReadModelPlace, UnitCardDoc } from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import type { IndexDefinition } from '@inmolink/platform/search';

export const LISTINGS_INDEX_UID = 'listings';

/** Longest description text indexed per locale (relevance comes from the start; keeps the index small). */
export const INDEXED_DESCRIPTION_CHARS = 1_000;

/**
 * PUBLIC: anyone (websites, portal) · SHARED: a SHARED listing, network search only (with `shareScope`) ·
 * RESTRICTED: a unit of a PRIVATE_NETWORK development — its owner and the agencies it is shared with (network search
 * filters by the developments the viewer may see, S5-05).
 */
export type IndexVisibility = 'PUBLIC' | 'SHARED' | 'RESTRICTED';

export interface ListingIndexDoc {
  id: string;
  kind: 'LISTING' | 'UNIT';
  ownerAgencyId: string;
  developmentId: string | null;
  status: string;
  visibility: IndexVisibility;
  shareScope: 'ALL' | 'PREFERRED';
  /** RESTRICTED units: the agencies their development is shared with (network search, S5-05); else empty. */
  allowedAgencyIds: string[];
  transactionType: string;
  propertyTypeId: string;
  /** Country, region, city and area ids: a filter on any level matches everything below it. */
  locationIds: string[];
  featureIds: string[];
  /** Null when the price is on request. */
  priceCents: number | null;
  priceOnRequest: boolean;
  beds: number | null;
  baths: number | null;
  /** Built m² (listing) or internal m² (unit). */
  areaM2: number | null;
  plotM2: number | null;
  geo: { lat: number; lng: number } | null;
  ref: string;
  /** First time the target had a read model, epoch seconds ("newest" sort). */
  publishedAt: number;
  /** The read models' source version (drift checks). */
  version: number;
  /** Hash of everything this document was built from (drift checks: same version, other content). */
  sourceHash: string;
  /** `title_<locale>`, `place_<locale>`, `description_<locale>`. */
  [localized: `${'title' | 'place' | 'description'}_${string}`]: string;
}

/** One `listing_read_models` row as the index builder reads it (only what the index needs from `detail`). */
export interface IndexSourceRow {
  targetId: string;
  locale: string;
  kind: 'LISTING' | 'UNIT';
  agencyId: string;
  developmentId: string | null;
  public: boolean;
  status: string;
  shareScope: string | null;
  allowedAgencyIds: string[] | null;
  version: number;
  etag: string;
  card: unknown;
  description: string | null;
  featureIds: string[];
  createdAt: Date;
}

const field = (name: 'title' | 'place' | 'description', locale: string) => `${name}_${locale}` as const;

/** The listings index: localized fields for every configured content locale (a new locale is a settings change). */
export function listingsIndex(
  uid: string = LISTINGS_INDEX_UID,
  locales: readonly string[] = CONTENT_LOCALES,
): IndexDefinition {
  return {
    uid,
    primaryKey: 'id',
    searchable: [
      'ref',
      ...locales.map((l) => field('title', l)),
      ...locales.map((l) => field('place', l)),
      ...locales.map((l) => field('description', l)),
    ],
    filterable: [
      { field: 'kind' },
      { field: 'ownerAgencyId' },
      { field: 'developmentId' },
      { field: 'status' },
      { field: 'visibility' },
      { field: 'shareScope' },
      { field: 'allowedAgencyIds' },
      { field: 'transactionType' },
      { field: 'propertyTypeId' },
      { field: 'locationIds' },
      { field: 'featureIds' },
      { field: 'priceOnRequest' },
      { field: 'priceCents', comparison: true },
      { field: 'beds', comparison: true },
      { field: 'baths', comparison: true },
      { field: 'areaM2', comparison: true },
      { field: 'plotM2', comparison: true },
      { field: 'publishedAt', comparison: true },
    ],
    sortable: ['priceCents', 'beds', 'areaM2', 'publishedAt'],
    localized: locales.map((l) => ({
      fields: [field('title', l), field('place', l), field('description', l)],
      locale: l,
    })),
    displayed: ['id'],
    exactOn: ['ref'],
    geo: true,
    maxTotalHits: 10_000,
    maxValuesPerFacet: 200,
  };
}

const placeText = (p: ReadModelPlace) =>
  [p.area, p.city, p.region, p.country].flatMap((t) => (t ? [t.name] : [])).join(', ');

const placeIds = (p: ReadModelPlace) => [p.country, p.region, p.city, p.area].flatMap((t) => (t ? [t.id] : []));

/**
 * One target's read-model rows (all its locales) → its index document, or null when it has none. Locale-free fields
 * come from the first row in locale order (they are the same in every row).
 */
export function buildIndexDoc(rows: readonly IndexSourceRow[]): ListingIndexDoc | null {
  const sorted = [...rows].sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));
  const first = sorted[0];
  if (!first) return null;
  const card = first.card as ListingCardDoc | UnitCardDoc;
  const isListing = first.kind === 'LISTING';
  const doc: ListingIndexDoc = {
    id: first.targetId,
    kind: first.kind,
    ownerAgencyId: first.agencyId,
    developmentId: first.developmentId,
    status: first.status,
    visibility: first.public ? 'PUBLIC' : isListing ? 'SHARED' : 'RESTRICTED',
    // A listing row from before share scopes reached read models (null) stays PREFERRED: never wider than it was.
    shareScope: isListing ? (first.shareScope === 'ALL' ? 'ALL' : 'PREFERRED') : 'ALL',
    allowedAgencyIds: first.public ? [] : [...(first.allowedAgencyIds ?? [])].sort(),
    transactionType: card.kind === 'LISTING' ? card.transactionType : 'SALE',
    propertyTypeId: card.propertyType.id,
    locationIds: placeIds(card.place),
    featureIds: [...first.featureIds].sort(),
    priceCents: card.price.onRequest ? null : card.price.amountCents,
    priceOnRequest: card.price.onRequest,
    beds: card.bedrooms,
    baths: card.bathrooms,
    areaM2: card.kind === 'LISTING' ? card.builtM2 : card.internalM2,
    plotM2: card.plotM2,
    geo: card.geo ? { lat: card.geo.lat, lng: card.geo.lng } : null,
    ref: card.ref,
    publishedAt: Math.floor(Math.min(...sorted.map((r) => r.createdAt.getTime())) / 1000),
    version: Math.max(...sorted.map((r) => r.version)),
    sourceHash: createHash('sha256')
      .update(
        JSON.stringify(
          // The allowed agencies only where there are any: other documents keep their hash (no repair walk).
          sorted.map((r) => [
            r.locale,
            r.etag,
            r.public,
            r.status,
            r.shareScope,
            r.featureIds,
            ...(r.allowedAgencyIds ? [r.allowedAgencyIds] : []),
          ]),
        ),
      )
      .digest('base64url')
      .slice(0, 22),
  };
  for (const r of sorted) {
    const c = r.card as ListingCardDoc | UnitCardDoc;
    doc[field('title', r.locale)] = c.title;
    doc[field('place', r.locale)] = placeText(c.place);
    if (r.description) doc[field('description', r.locale)] = r.description.slice(0, INDEXED_DESCRIPTION_CHARS);
  }
  return doc;
}
