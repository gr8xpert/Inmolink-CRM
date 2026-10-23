/**
 * The legacy website API shim `/v1` (S8-02, PLAN §9.3, §3 #43): a legacy website's request mapped to the v2 reads of
 * this module, and their answer reshaped into the legacy body.
 *
 * Legacy ids resolve through the migration module: the type, location and feature ids of legacy filters from its
 * per-process taxonomy maps (no statement on the request path), a property id through its SECURITY DEFINER lookup
 * (cached; one statement the first time a process meets it). A page's listings are named by their legacy ids in the
 * page's own presentation statement (`viewWith`), so the shim adds no statement to a v2 read: search 1–2 (fallback
 * +1, never above 3), detail 2–3.
 *
 * The response shapes are ASSUMED (contracts `legacy-v1.ts`) until the recorded golden files (S8-01, H2) exist; the
 * golden-parity suite (`tests/golden/legacy-v1.golden.int.test.ts`) is the judge. White-labelling is the v2
 * serializer's: the shim only renames and drops fields of what a v2 answer already shows.
 */
import type {
  LegacyPropertiesQuery,
  LegacyPropertyDetail,
  LegacyPropertyList,
  LegacyPropertyResponse,
  LegacyPropertySummary,
  LegacyTypesResponse,
  ListingDetailDoc,
  TransactionType,
  UnitDetailDoc,
  WebsiteCard,
  WebsiteDetail,
  WebsiteListingsQuery,
  WebsiteTypesDto,
} from '@inmolink/contracts';
import { PUBLIC_SEARCH_STATUSES } from '@inmolink/contracts';
import { withPublicRead } from '@inmolink/db';
import { LocalLru } from '@inmolink/platform/cache';
import * as migration from '../migration';
import * as search from '../search';
import * as taxonomy from '../taxonomy';
import * as websites from '../websites';
import { wrapSearchCursor } from './cursor';
import { type ApiSite, listingNotFound, owned, searchPage, viewWith } from './service';

/** A legacy `lang` this site does not speak falls back to its default (legacy sites send their own UI language). */
function legacyLocale(site: ApiSite, lang: string | undefined): string {
  return lang !== undefined && site.scope.locales.includes(lang) ? lang : site.scope.defaultLocale;
}

const STATUS: Record<string, LegacyPropertySummary['status']> = {
  ACTIVE: 'available',
  AVAILABLE: 'available',
  UNDER_OFFER: 'under_offer',
  RESERVED: 'reserved',
};

/**
 * Legacy transaction names (S8-02 Decision): `sale`, `rent` (long-term) and `holiday` (short-term) — one name per v2
 * type, so the filter and the field a listing shows always agree.
 */
const TRANSACTION: Record<TransactionType, LegacyPropertySummary['transaction']> = {
  SALE: 'sale',
  RENT_LONG_TERM: 'rent',
  RENT_SHORT_TERM: 'holiday',
};
const TRANSACTION_FILTER: Record<LegacyPropertySummary['transaction'], TransactionType> = {
  sale: 'SALE',
  rent: 'RENT_LONG_TERM',
  holiday: 'RENT_SHORT_TERM',
};

const wholeEuros = (cents: number | null, onRequest: boolean) =>
  cents === null || onRequest ? null : Math.round(cents / 100);

type Shown = WebsiteCard | WebsiteDetail;

/** The fields a legacy summary shares with the detail, from a v2 card or detail. */
function summaryOf(
  item: Shown,
  legacyIds: ReadonlyMap<string, string>,
  names: migration.LegacyTaxonomy,
  targetId: string | undefined,
) {
  const place = item.place;
  const listing = item.kind === 'LISTING' ? item : null;
  const cover = listing?.cover ?? null;
  return {
    id: (targetId === undefined ? undefined : legacyIds.get(targetId)) ?? item.ref,
    ref: item.ref,
    kind: item.kind === 'LISTING' ? 'property' : 'unit',
    title: item.title,
    status: STATUS[item.status] ?? 'sold',
    transaction: listing ? TRANSACTION[listing.transactionType] : 'sale',
    price: wholeEuros(item.price.amountCents, item.price.onRequest),
    currency: item.price.currency,
    price_on_request: item.price.onRequest,
    type: item.propertyType.name,
    type_id: names.legacyIdOf(item.propertyType.id) ?? item.propertyType.id,
    location: (place.area ?? place.city ?? place.region ?? place.country)?.name ?? null,
    city: place.city?.name ?? null,
    province: place.region?.name ?? null,
    beds: item.bedrooms,
    baths: item.bathrooms,
    built: listing ? listing.builtM2 : item.kind === 'UNIT' ? item.internalM2 : null,
    plot: item.plotM2,
    latitude: item.geo?.lat ?? null,
    longitude: item.geo?.lng ?? null,
    image: cover ? (cover.urls.medium ?? cover.urls.large ?? null) : null,
  } satisfies LegacyPropertySummary;
}

/**
 * The legacy filter ids of a request as v2 ids, from the process's taxonomy maps (no statement), or `null` when they
 * can match nothing. Any of the types or locations: unknown ones are ignored while one is known. Every feature: one
 * unknown feature matches no listing.
 */
function filterIds(q: LegacyPropertiesQuery, names: migration.LegacyTaxonomy) {
  const ids = (entity: 'propertyType' | 'location' | 'feature', legacy: readonly string[] | undefined) =>
    legacy?.flatMap((l) => names.newId(entity, l) ?? []);
  const types = ids('propertyType', q.type);
  const locations = ids('location', q.location);
  const features = ids('feature', q.feature);
  if (types?.length === 0 || locations?.length === 0) return null;
  if (features && features.length !== (q.feature ?? []).length) return null;
  return { types, locations, features };
}

const emptyList = (q: LegacyPropertiesQuery, total: number): LegacyPropertyList => ({
  status: 'ok',
  page: q.page,
  per_page: q.limit,
  total,
  total_pages: Math.ceil(total / q.limit),
  properties: [],
});

/**
 * `GET /v1/properties` (legacy `/api/properties`): one page of the site's listings. Legacy `page` numbers become the
 * search engine's offset (signed like any `/v2/listings` cursor, so the paging rules and honeytokens follow the page
 * depth); past the engine's 10,000-result cap, or while the Postgres fallback answers (keyset only — it never runs an
 * SQL OFFSET), a page after the first is empty, with the total, and reads no document.
 */
export async function legacyProperties(
  site: ApiSite,
  q: LegacyPropertiesQuery,
  opts: { suspicious?: boolean } = {},
): Promise<LegacyPropertyList> {
  const lang = legacyLocale(site, q.lang);
  const names = await migration.legacyTaxonomy();
  const filters = filterIds(q, names);
  if (filters === null) return emptyList(q, 0);
  const inner = search.searchOffsetCursor(q.sort, (q.page - 1) * q.limit);
  const query: WebsiteListingsQuery = {
    lang,
    sort: q.sort,
    limit: q.limit,
    // Every status a site shows a page for (under offer and reserved too): legacy lists had no status filter.
    status: [...PUBLIC_SEARCH_STATUSES],
    q: q.q,
    types: filters.types,
    locations: filters.locations,
    features: filters.features,
    transaction: q.transaction === undefined ? undefined : TRANSACTION_FILTER[q.transaction],
    priceMin: q.min_price === undefined ? undefined : q.min_price * 100,
    priceMax: q.max_price === undefined ? undefined : q.max_price * 100,
    bedsMin: q.beds,
    bathsMin: q.baths,
    cursor: inner ? wrapSearchCursor(site.scope.siteId, q.page - 1, inner) : undefined,
  };
  if (inner === null) {
    // Past the cap: no page, but the total of the first (one card read).
    const first = await searchPage(site, { ...query, limit: 1, cursor: undefined }, opts);
    return emptyList(q, first.page.total);
  }
  const found = await searchPage(site, query, {
    ...opts,
    // The fallback restarted an offset page at its first keyset page: that is not page `q.page` (no document read).
    dropRestarted: q.page > 1,
    extra: (rows) => migration.legacyIdsQuery(rows.map((r) => r.targetId)).sql,
  });
  const { page } = found;
  if (page.resultsChanged) return emptyList(q, page.total);
  const legacyIds = migration.legacyIdsQuery([]).read(found.extra);
  return {
    status: 'ok',
    page: q.page,
    per_page: q.limit,
    total: page.total,
    total_pages: Math.ceil(page.total / q.limit),
    properties: page.items.map((card) => summaryOf(card, legacyIds, names, found.targetOf.get(card.id))),
  };
}

/**
 * `GET /v1/properties/{id}` (legacy `/api/properties/{id}`): a legacy property id (a listing's or a new-build unit's),
 * else a reference as the site shows it. Only among the site's inventory: a legacy id of a listing the site does not
 * show falls back to the reference form, and is then the same 404 as an unknown one. An id in the site's network
 * reference form (`<prefix>-…`) is never looked up as a legacy id.
 */
export async function legacyProperty(site: ApiSite, id: string, lang?: string): Promise<LegacyPropertyResponse> {
  const locale = legacyLocale(site, lang);
  const inventory = site.inventory;
  if (!inventory) throw await withPublicRead((tx) => listingNotFound(tx, site, id));
  const prefix = site.scope.referencePrefix;
  const networkForm = prefix !== null && id.toUpperCase().startsWith(`${prefix.toUpperCase()}-`);
  const [target, names] = await Promise.all([
    networkForm ? null : migration.legacyTarget(id),
    migration.legacyTaxonomy(),
  ]);
  return search.withSiteRead(inventory, async (tx) => {
    const fallback = site.scope.defaultLocale;
    const row =
      (target ? await search.publicDetailById(tx, inventory, target.newId, locale, fallback) : null) ??
      (await search.publicDetailByRef(tx, inventory, id, locale, fallback));
    if (!row) throw await listingNotFound(tx, site, id);
    site.edge.targets.add(row.targetId);
    const named = migration.legacyIdsQuery([row.targetId]);
    const shown = await viewWith(tx, site, locale, [row], named.sql);
    const detail = websites.serializeDetail(shown.view, owned<ListingDetailDoc | UnitDetailDoc>(row));
    return { status: 'ok', property: detailOf(detail, named.read(shown.extra), names, row.targetId) };
  });
}

function detailOf(
  detail: WebsiteDetail,
  legacyIds: ReadonlyMap<string, string>,
  names: migration.LegacyTaxonomy,
  targetId: string,
) {
  const listing = detail.kind === 'LISTING' ? detail : null;
  const images = (listing?.media ?? []).flatMap((m) =>
    m.kind === 'VIDEO' ? [] : [m.urls.large ?? m.urls.medium ?? ''].filter((u) => u !== ''),
  );
  return {
    ...summaryOf(detail, legacyIds, names, targetId),
    description: detail.description,
    terrace: detail.terraceM2,
    year_built: listing?.yearBuilt ?? null,
    energy_rating: listing?.energyRating ?? null,
    features: (listing?.features ?? []).map((f) => f.name),
    images,
    agency: {
      name: detail.agency.name,
      email: detail.agency.email,
      phone: detail.agency.phone,
      website: detail.agency.website,
    },
  } satisfies LegacyPropertyDetail;
}

/** Legacy type lists by taxonomy version (the v2 document's ETag), locale and taxonomy-map size. */
const typeLists = new LocalLru<LegacyTypesResponse>(50);
const TYPES_TTL_MS = 60_000;

/** Tests: forget reshaped type lists. */
export function resetLegacyCaches(): void {
  typeLists.clear();
}

/**
 * `GET /v1/types` (legacy `/api/types`): the platform's property types in `lang`, flat, each named by its legacy id
 * (its v2 id when it has none). No statement when warm: the v2 catalog is cached, the names come from the taxonomy maps.
 */
export async function legacyTypes(lang?: string): Promise<LegacyTypesResponse> {
  const [doc, names] = await Promise.all([taxonomy.getWebsiteTypes(lang), migration.legacyTaxonomy()]);
  const key = `${doc.etag}:${lang ?? ''}:${names.size}`;
  const hit = typeLists.get(key);
  if (hit) return hit;
  const catalog = JSON.parse(doc.json) as WebsiteTypesDto;
  const list: LegacyTypesResponse = {
    status: 'ok',
    types: catalog.propertyTypes
      .flatMap((g) => g.types)
      .map((t) => ({ id: names.legacyIdOf(t.id) ?? t.id, name: t.name, slug: t.slug })),
  };
  typeLists.set(key, list, TYPES_TTL_MS);
  return list;
}
