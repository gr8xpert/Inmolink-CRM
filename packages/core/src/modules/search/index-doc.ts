/**
 * The listings search index (S5-02, ADR 0005, PLAN §3 #16): one index, one document per listing or new-build unit,
 * built only from its `listing_read_models` rows (one per content locale). Localized text goes in per-locale fields
 * (`title_es`, `place_es`, `description_es`) and the query picks the request locale's; everything else is
 * locale-free ids and numbers for filters, facets and sorting. The index finds ids — results are hydrated from read
 * models — so it holds no client-facing field that would need white-labelling. Owner agency and share scope are
 * filter fields only (never displayed: `displayed` is the id).
 *
 * **White-labelled matching (S7-F5):** the indexed title and description are the owner's text as the white-label
 * sanitizer leaves it — plain text without the owner's names, e-mail, phone, website or own reference, and without
 * any e-mail, URL, domain or phone number — so a visitor of a site showing network listings cannot find an owner's
 * listings by typing who the owner is. The owner is the same on every site, so the text is cleaned once, here, for
 * every document (own sites included: an agency's own contact details in its texts no longer match either).
 * Place names come from the taxonomy (never owner text) and are indexed as they are.
 */
import { createHash } from 'node:crypto';
import type { ListingCardDoc, ReadModelPlace, UnitCardDoc } from '@inmolink/contracts';
import { CONTENT_LOCALES } from '@inmolink/i18n';
import type { IndexDefinition } from '@inmolink/platform/search';
import { placeText } from '../../place-text';
import { cutAtWord, type OwnerMatcher, plainText, SANITIZER_VERSION } from '../../white-label';

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
  /** A PUBLIC listing hidden from the network for going unconfirmed (S6-F2): network search leaves it out. */
  networkHidden: boolean;
  /** A PREFERRED listing: the agencies its owner prefers (network search, S6-F2); else empty. */
  preferredAgencyIds: string[];
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
  /**
   * The target's public code (S7-02, `listing_public_codes`): websites show and match another agency's document as
   * `<prefix>-<code>`, never by its owner's `ref`. Null until the target has one.
   */
  publicCode: string | null;
  /**
   * The total commission in basis points of the price (S7-F4: a CUSTOM site's minimum commission on network
   * listings); null: none or unknown. Read from its own source at build time, never from the read models; a filter
   * field only (`displayed` is the id).
   */
  commissionBp: number | null;
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
  networkHidden: boolean;
  preferredAgencyIds: string[] | null;
  version: number;
  etag: string;
  card: unknown;
  description: string | null;
  featureIds: string[];
  createdAt: Date;
  /** The target's public code (S7-02), when it has one. */
  publicCode: string | null;
  /** The target's total commission in basis points of its price (S7-F4), from its own source; null: none or unknown. */
  commissionBp: number | null;
}

/** One target's commission and price as the index needs them (`commissionShareBp`). */
export interface IndexCommissionTerms {
  priceCents: number | null;
  priceOnRequest: boolean;
  /** The price's currency. */
  currency: string;
  commissionBp: number | null;
  commissionFixedCents: number | null;
  /** The fixed amount's currency. */
  commissionCurrency: string;
}

/**
 * The total commission as basis points of the price (S7-F4): a percentage as it is; a fixed amount as its share of
 * the price (rounded down), when the price is known and in the same currency — an on-request price, no price or
 * another currency is unknown (null: a site's minimum excludes it). Capped at 10000.
 */
export function commissionShareBp(t: IndexCommissionTerms): number | null {
  if (t.commissionBp !== null) return Math.min(t.commissionBp, 10_000);
  if (t.commissionFixedCents === null || t.priceOnRequest || t.priceCents === null || t.priceCents <= 0) return null;
  if (t.commissionCurrency !== t.currency) return null;
  return Math.min(Number((BigInt(t.commissionFixedCents) * 10_000n) / BigInt(t.priceCents)), 10_000);
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
      // The primary key, compared: the repair walk pages the index by id (S6-F2), never on request paths.
      { field: 'id', comparison: true },
      { field: 'kind' },
      { field: 'ownerAgencyId' },
      { field: 'developmentId' },
      { field: 'status' },
      { field: 'visibility' },
      { field: 'shareScope' },
      { field: 'allowedAgencyIds' },
      { field: 'networkHidden' },
      { field: 'preferredAgencyIds' },
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
      // Website search on sites showing network listings (S7-02): references match by filter, never as free text,
      // so a network document is found by the site's prefixed reference only — not by the owner's own.
      { field: 'ref' },
      { field: 'publicCode' },
      // A CUSTOM site's minimum commission on network listings (S7-F4): filter only, never displayed.
      { field: 'commissionBp', comparison: true },
    ],
    sortable: ['priceCents', 'beds', 'areaM2', 'publishedAt', 'id'],
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

const placeIds = (p: ReadModelPlace) => [p.country, p.region, p.city, p.area].flatMap((t) => (t ? [t.id] : []));

/**
 * Owner text as the index matches it (S7-F5): plain, white-label sanitized, at most `max` characters. The sanitizer
 * reads at most twice `max` characters (a hard cap, so its cost stays bounded on any description), cut at a word
 * boundary — never inside an e-mail or a name, which it then could not recognise — and the clean text is cut at a
 * word boundary again.
 */
export function indexedText(text: string, owner: OwnerMatcher, ownerRef: string, max: number): string {
  return cutAtWord(owner.clean(plainText(cutAtWord(text, max * 2)), [ownerRef]), max);
}

/** Longest title text indexed per locale (titles are short; the cap only bounds the sanitizer). */
const INDEXED_TITLE_CHARS = 500;

/**
 * One target's read-model rows (all its locales) → its index document, or null when it has none. Locale-free fields
 * come from the first row in locale order (they are the same in every row). `owner` is the owner agency's identity
 * (`search.ownerIdentitiesForIndex`, compiled once per owner by `compileOwner`), removed from the indexed text
 * (S7-F5); it and the sanitizer version are part of `sourceHash`, so an identity or rules change re-pushes the
 * document. Null: a document without text (the Postgres fallback rows, which match no text: their hash leaves the
 * identity out, so an identity change rewrites none).
 */
export function buildIndexDoc(rows: readonly IndexSourceRow[], owner: OwnerMatcher | null): ListingIndexDoc | null {
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
    networkHidden: first.networkHidden,
    preferredAgencyIds: [...(first.preferredAgencyIds ?? [])].sort(),
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
    publicCode: first.publicCode,
    commissionBp: first.commissionBp,
    publishedAt: Math.floor(Math.min(...sorted.map((r) => r.createdAt.getTime())) / 1000),
    version: Math.max(...sorted.map((r) => r.version)),
    sourceHash: createHash('sha256')
      .update(
        JSON.stringify(
          // The allowed agencies, the freshness flag and the preferred list only where set: other documents keep
          // their hash (no repair walk).
          sorted.map((r) => [
            r.locale,
            r.etag,
            r.public,
            r.status,
            r.shareScope,
            r.featureIds,
            ...(r.allowedAgencyIds ? [r.allowedAgencyIds] : []),
            ...(r.networkHidden ? ['networkHidden'] : []),
            ...(r.preferredAgencyIds ? [{ preferred: r.preferredAgencyIds }] : []),
            ...(r.publicCode ? [{ code: r.publicCode }] : []),
            ...(r.commissionBp !== null ? [{ commission: r.commissionBp }] : []),
          ]),
        ),
      )
      // The indexed text is the read models' text cleaned of the owner's identity (S7-F5).
      .update(owner === null ? '' : JSON.stringify({ whiteLabel: SANITIZER_VERSION, owner: owner.identity }))
      .digest('base64url')
      .slice(0, 22),
  };
  if (owner === null) return doc;
  for (const r of sorted) {
    const c = r.card as ListingCardDoc | UnitCardDoc;
    doc[field('title', r.locale)] = indexedText(c.title, owner, c.ref, INDEXED_TITLE_CHARS);
    doc[field('place', r.locale)] = placeText(c.place, ['area', 'city', 'region', 'country']);
    if (r.description)
      doc[field('description', r.locale)] = indexedText(r.description, owner, c.ref, INDEXED_DESCRIPTION_CHARS);
  }
  return doc;
}
