/**
 * The public portal's reads (S15-01, PLAN §3 #63, §7 M14: inmolink.es): every agency's PUBLIC listings, searched,
 * shown in detail and grouped by location — read by `apps/public` server components. Like a network-wide website
 * (`search.PublicSearchSite` with `ownerAgencyIds: null`), except that each listing is presented as its own agency's:
 * the portal names the listing agency (the visitor contacts it, S15-02) and links to its profile (S15-03), so no text
 * is white-labelled and the owner's reference is shown. Commission, internal notes and owner (vendor) contacts are not
 * in the read models at all; agencies show only their published profile.
 *
 * Read path (CLAUDE.md rule 9): the search adapter for ids and facet counts, `listing_read_models` for the documents,
 * the taxonomy's cached tree and catalog for places and filters, all as `app_public`. Statements per page, warm: search
 * 1 (documents) + 1 when an agency on the page is not cached (published profiles, cached here for 5 minutes) + 1 when
 * the Postgres fallback answers; a listing page 1–2.
 *
 * R1 scope: the search lists resale listings only (new-build units have no photos of their own); each development has
 * its own page with its unit table (`portalDevelopment`), linked from listings that belong to one.
 */
import type {
  ListingCardDoc,
  ListingDetailDoc,
  PortalQuery,
  PortalSort,
  UnitCardDoc,
  UnitDetailDoc,
  WebsiteListingCard,
} from '@inmolink/contracts';
import {
  PORTAL_MAX_PAGE,
  PORTAL_MAX_SEARCH_TYPES,
  PORTAL_PAGE_SIZE,
  PORTAL_ZONE_MAX_MEMBERS,
  PublicCode,
} from '@inmolink/contracts';
import { type Tx, withPublicRead } from '@inmolink/db';
import { type ContentLocale, DEFAULT_CONTENT_LOCALE, FALLBACK_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { LocalLru } from '@inmolink/platform/cache';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import * as agencies from '../agencies';
import * as search from '../search';
import * as taxonomy from '../taxonomy';
import * as websites from '../websites';
import { FEATURE_CONCEPTS } from './ai-search-parse';
import { configured } from './settings';

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'portal' });
  return log;
};

// ── Listed agencies ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The portal shows only the stock of agencies listed in the directory (verified, active, not suspended, not opted
 * out — `agency_directory.listed`, Decision S15-01 review). Search documents carry their owner but not its standing, so
 * the portal names owners in the query — totals, facets and pages stay right: the listed agencies
 * (`agencies.listedAgencyIds`), or every other owner of a search document (`search.searchDocOwners`, a skip scan, minus
 * the listed ones) to leave out, whichever set is smaller (production: a few unlisted owners). Kept for a minute per
 * process and refreshed in the background while the old set answers, so a page pays the two statements only on a cold
 * process; an agency's change of standing shows within about a minute.
 */
const OWNER_SCOPE_REFRESH_MS = 60_000;

/** Whose documents the portal shows: the listed agencies, or everyone but the unlisted owners. */
type OwnerScope = { show: string[] } | { hide: string[] };

let ownerScope: { scope: OwnerScope; at: number } | undefined;
let ownerScopeLoad: Promise<OwnerScope> | undefined;

function loadOwnerScope(): Promise<OwnerScope> {
  ownerScopeLoad ??= withPublicRead(async (tx) => {
    const listed = await agencies.listedAgencyIds(tx);
    const listedSet = new Set(listed);
    const hide = (await search.searchDocOwners(tx)).filter((o) => !listedSet.has(o));
    if (Math.min(hide.length, listed.length) > search.MAX_EXCLUDED_OWNERS) {
      logger().error(
        { listed: listed.length, unlisted: hide.length, max: search.MAX_EXCLUDED_OWNERS },
        'portal: too many owners to name in a search; showing the first listed agencies only',
      );
    }
    const scope: OwnerScope =
      hide.length <= listed.length
        ? { hide: hide.slice(0, search.MAX_EXCLUDED_OWNERS) }
        : { show: listed.slice(0, search.MAX_EXCLUDED_OWNERS) };
    return scope;
  })
    .then((scope) => {
      ownerScope = { scope, at: Date.now() };
      return scope;
    })
    .finally(() => {
      ownerScopeLoad = undefined;
    });
  return ownerScopeLoad;
}

/** The owner scope (cached; the previous one answers while it refreshes). */
async function currentOwnerScope(): Promise<OwnerScope> {
  if (ownerScope && Date.now() - ownerScope.at < OWNER_SCOPE_REFRESH_MS) return ownerScope.scope;
  const next = loadOwnerScope();
  if (!ownerScope) return next;
  next.catch((err: unknown) => logger().warn({ err }, 'portal: refreshing the listed agencies failed'));
  return ownerScope.scope;
}

/**
 * An inventory of the listed agencies' PUBLIC documents with `extra` (null: no agency is listed — nothing to show).
 */
async function listedInventory(
  requestId: string,
  extra: Pick<search.PublicSearchSite, 'restrict'> = {},
): Promise<search.PublicSearchSite | null> {
  const scope = await currentOwnerScope();
  if ('show' in scope) {
    return scope.show.length === 0 ? null : { ownerAgencyIds: scope.show, ...extra, requestId };
  }
  return { ownerAgencyIds: null, excludeOwnerAgencyIds: scope.hide, ...extra, requestId };
}

/** The portal's search inventory: listed agencies' PUBLIC listings (no new-build units in R1). */
const portalInventory = (requestId: string) => listedInventory(requestId, { restrict: { newBuilds: false } });

/** A content locale for `locale` (UI locales are content locales; anything else reads the default). */
const contentLocale = (locale: string): ContentLocale => (isContentLocale(locale) ? locale : DEFAULT_CONTENT_LOCALE);
/** The locale a document falls back to when it has none in the page's. */
const fallbackOf = (locale: ContentLocale): string =>
  locale === DEFAULT_CONTENT_LOCALE ? FALLBACK_CONTENT_LOCALE : DEFAULT_CONTENT_LOCALE;

// ── Places ──────────────────────────────────────────────────────────────────────────────────────────────────────

type LocationLevel = 'COUNTRY' | 'REGION' | 'CITY' | 'AREA';

/** A location as the portal links it: its slugs from the country down (`/properties/<path…>`). */
export interface PortalPlace {
  id: string;
  level: LocationLevel;
  name: string;
  path: readonly string[];
}

/** A location group (a comarca, a coast) as the portal links it (`/zone/<slug>`). */
export interface PortalZone {
  id: string;
  name: string;
  slug: string;
  /** Its member locations, in the tree's order (at most `PORTAL_ZONE_MAX_MEMBERS` are searched). */
  members: PortalPlace[];
}

/** The caps live in contracts (S15-F8) so the staff editor refuses what the portal would cut; re-exported here. */
export { PORTAL_MAX_SEARCH_TYPES, PORTAL_ZONE_MAX_MEMBERS };

interface PlaceNode extends PortalPlace {
  parentId: string | null;
  childIds: string[];
}

interface PlaceIndex {
  byId: Map<string, PlaceNode>;
  roots: PlaceNode[];
  zones: Map<string, { id: string; name: string; slug: string; locationIds: string[] }>;
  zoneById: Map<string, { slug: string }>;
}

type TreeNode = { id: string; level: string; name: string; slug: string; children?: TreeNode[] };

/** Built indexes per locale with the tree ETag they were built from (a taxonomy edit brings a new tree). */
const placeIndexes = new Map<string, { etag: string; index: PlaceIndex }>();

async function placeIndex(locale: ContentLocale): Promise<PlaceIndex> {
  const { locations } = await taxonomy.websiteTaxonomyObjects(locale);
  const hit = placeIndexes.get(locale);
  if (hit && hit.etag === locations.etag) return hit.index;
  const byId = new Map<string, PlaceNode>();
  const walk = (nodes: readonly TreeNode[], parent: PlaceNode | null): PlaceNode[] =>
    nodes.map((n) => {
      const node: PlaceNode = {
        id: n.id,
        level: n.level as LocationLevel,
        name: n.name,
        path: parent ? [...parent.path, n.slug] : [n.slug],
        parentId: parent?.id ?? null,
        childIds: [],
      };
      byId.set(n.id, node);
      node.childIds = walk(n.children ?? [], node).map((c) => c.id);
      return node;
    });
  const roots = walk(locations.body.locations as unknown as TreeNode[], null);
  const zones = new Map<string, { id: string; name: string; slug: string; locationIds: string[] }>();
  const zoneById = new Map<string, { slug: string }>();
  for (const g of locations.body.locationGroups) {
    zones.set(g.slug, { id: g.id, name: g.name, slug: g.slug, locationIds: g.locationIds });
    zoneById.set(g.id, { slug: g.slug });
  }
  const index: PlaceIndex = { byId, roots, zones, zoneById };
  placeIndexes.set(locale, { etag: locations.etag, index });
  return index;
}

const shown = (n: PlaceNode): PortalPlace => ({ id: n.id, level: n.level, name: n.name, path: n.path });

/** A location page: the place its slugs name (country first), its ancestors (country first) and its children. */
export interface PortalLocation {
  place: PortalPlace;
  ancestors: PortalPlace[];
  children: PortalPlace[];
}

/** The location `slugs` name in `locale` (each slug a child of the one before, the first a country); null: none. */
export async function portalLocation(locale: string, slugs: readonly string[]): Promise<PortalLocation | null> {
  if (slugs.length === 0 || slugs.length > 4) return null;
  const index = await placeIndex(contentLocale(locale));
  let level: PlaceNode[] = index.roots;
  const lineage: PlaceNode[] = [];
  for (const slug of slugs) {
    const next = level.find((n) => n.path[n.path.length - 1] === slug);
    if (!next) return null;
    lineage.push(next);
    level = next.childIds.map((id) => index.byId.get(id) as PlaceNode);
  }
  const place = lineage[lineage.length - 1] as PlaceNode;
  return { place: shown(place), ancestors: lineage.slice(0, -1).map(shown), children: level.map(shown) };
}

/** The place of a location id with its ancestors (a listing's breadcrumb); null: not in the tree. */
export async function portalPlaceOf(
  locale: string,
  id: string,
): Promise<{ place: PortalPlace; ancestors: PortalPlace[] } | null> {
  const index = await placeIndex(contentLocale(locale));
  const node = index.byId.get(id);
  if (!node) return null;
  const ancestors: PortalPlace[] = [];
  for (let p = node.parentId; p; p = index.byId.get(p)?.parentId ?? null) {
    const parent = index.byId.get(p);
    if (parent) ancestors.unshift(shown(parent));
  }
  return { place: shown(node), ancestors };
}

/** The same location's slugs in each of `locales` (hreflang alternates); a locale without it is left out. */
export async function portalLocationPaths(
  id: string,
  locales: readonly string[],
): Promise<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const l of locales) {
    const node = (await placeIndex(contentLocale(l))).byId.get(id);
    if (node) out[l] = node.path;
  }
  return out;
}

/** The zone (location group) `slug` names in `locale`, with its members; null: none. */
export async function portalZone(locale: string, slug: string): Promise<PortalZone | null> {
  const index = await placeIndex(contentLocale(locale));
  const zone = index.zones.get(slug);
  if (!zone) return null;
  const members = zone.locationIds.flatMap((id) => {
    const n = index.byId.get(id);
    return n ? [shown(n)] : [];
  });
  return { id: zone.id, name: zone.name, slug: zone.slug, members };
}

/** The same zone's slug in each of `locales` (hreflang alternates). */
export async function portalZoneSlugs(id: string, locales: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const l of locales) {
    const z = (await placeIndex(contentLocale(l))).zoneById.get(id);
    if (z) out[l] = z.slug;
  }
  return out;
}

/** The portal's entry points: countries with their regions, and every zone (the home page). */
export async function portalDirectory(
  locale: string,
): Promise<{ countries: { place: PortalPlace; regions: PortalPlace[] }[]; zones: { name: string; slug: string }[] }> {
  const index = await placeIndex(contentLocale(locale));
  return {
    countries: index.roots.map((c) => ({
      place: shown(c),
      regions: c.childIds.map((id) => shown(index.byId.get(id) as PlaceNode)),
    })),
    zones: [...index.zones.values()]
      .filter((z) => z.locationIds.length > 0)
      .map((z) => ({ name: z.name, slug: z.slug }))
      .sort((a, b) => a.name.localeCompare(b.name, contentLocale(locale))),
  };
}

// ── Filters ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Property types as the portal's filter groups them (the taxonomy's type groups: apartments, houses, plots…). */
export interface PortalTypeGroup {
  id: string;
  slug: string;
  name: string;
  types: { id: string; slug: string; name: string }[];
}

/** The filter options in `locale`: type groups, and the portal features the taxonomy has (resolved by name). */
export interface PortalCatalog {
  /** Every type group (slugs in the URL resolve against these). */
  typeGroups: PortalTypeGroup[];
  /** The groups the filter offers (at most `PORTAL_MAX_FILTER_TYPES` types). */
  filterGroups: PortalTypeGroup[];
  /** Portal feature key → the taxonomy feature it filters on (keys the taxonomy cannot name are absent). */
  features: Partial<Record<'sea-views' | 'golf', string>>;
}

/**
 * Taxonomy names each portal feature may be catalogued under (the AI search's concepts, S12-08), in preference order:
 * the first one the taxonomy knows is the filter (the search requires every chosen feature, so one id per feature).
 */
const FEATURE_TERMS: Record<'sea-views' | 'golf', readonly string[]> = {
  'sea-views': FEATURE_CONCEPTS['sea-views'],
  golf: [...FEATURE_CONCEPTS['golf-views'], ...FEATURE_CONCEPTS['frontline-golf'], 'golf'],
};

/** Most property types the filter offers as options (URL slugs resolve against the whole catalog). */
export const PORTAL_MAX_FILTER_TYPES = 60;

export async function portalCatalog(locale: string): Promise<PortalCatalog> {
  const l = contentLocale(locale);
  const { catalog } = await taxonomy.websiteTaxonomyObjects(l);
  const vocabulary = await taxonomy.searchVocabulary(l);
  const features: PortalCatalog['features'] = {};
  for (const [key, terms] of Object.entries(FEATURE_TERMS) as ['sea-views' | 'golf', readonly string[]][]) {
    const id = terms.map((t) => vocabulary.features(t)[0]).find((x) => x !== undefined);
    if (id) features[key] = id;
  }
  const typeGroups: PortalTypeGroup[] = catalog.body.propertyTypes.map((g) => ({
    id: g.id,
    slug: g.slug,
    name: g.name,
    types: g.types.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
  }));
  // The filter's options: the catalog's order (staff `sort`), at most `PORTAL_MAX_FILTER_TYPES` types — every option is
  // markup on every search page (a curated catalog has a few dozen; the cap keeps a runaway one from bloating it).
  const filterGroups: PortalTypeGroup[] = [];
  let left = PORTAL_MAX_FILTER_TYPES;
  for (const g of typeGroups) {
    if (left <= 0) break;
    const types = g.types.slice(0, left);
    if (types.length === 0) continue;
    left -= types.length;
    filterGroups.push({ ...g, types });
  }
  return { typeGroups, filterGroups, features };
}

/** Type and type-group slugs → the type ids they name (a group stands for all its types). */
function typeIdsOf(catalog: PortalCatalog, slugs: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const slug of slugs) {
    for (const g of catalog.typeGroups) {
      if (g.slug === slug) for (const t of g.types) ids.add(t.id);
      for (const t of g.types) if (t.slug === slug) ids.add(t.id);
    }
  }
  return [...ids];
}

// ── Agencies ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The listing agency as the portal shows it: its directory name and published contact details. */
export interface PortalAgency {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
}

/** Published profiles by agency id; null: not listed (unverified or left the directory) — no agency is named. */
const agencyCache = new LocalLru<PortalAgency | null>(10_000);
const AGENCY_TTL_MS = 5 * 60_000;
const UNLISTED_TTL_MS = 60_000;

/** Tests: forget cached agencies. */
export function resetPortalCaches(): void {
  agencyCache.clear();
  placeIndexes.clear();
  ownerScope = undefined;
}

/** The listed agencies among `ids`, cached; the missing ones in one statement. */
async function agenciesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, PortalAgency | null>> {
  const out = new Map<string, PortalAgency | null>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = agencyCache.get(id);
    if (hit !== undefined) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  const found = await agencies.publicAgencies(tx, missing);
  for (const id of missing) {
    const a = found.get(id);
    const agency: PortalAgency | null = a
      ? { id, name: a.name, email: a.contactEmail, phone: a.contactPhone, website: a.websiteUrl }
      : null;
    agencyCache.set(id, agency, agency ? AGENCY_TTL_MS : UNLISTED_TTL_MS);
    out.set(id, agency);
  }
  return out;
}

/** The agency as the website serializer's presenter (each listing presented as its own agency's). */
const presenterOf = (agency: PortalAgency | null): websites.SiteView['presenter'] => ({
  name: agency?.name ?? '',
  email: agency?.email ?? null,
  phone: agency?.phone ?? null,
  whatsapp: null,
  website: agency?.website ?? null,
  primaryColor: null,
  accentColor: null,
});

/** The owner's own view: its own text and reference, its own presenter — nothing white-labelled. */
const ownView = (ownerAgencyId: string, agency: PortalAgency | null): websites.SiteView => ({
  site: { agencyId: ownerAgencyId, referencePrefix: null },
  presenter: presenterOf(agency),
  mediaBaseUrl: configured().mediaBaseUrl,
});

// ── Search ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A result card: the website card (own view), its public code (the listing page's URL) and the portal extras. */
export interface PortalCard {
  card: WebsiteListingCard;
  /** The listing's public code: its page is `/property/<slug>-<code>`. Null before its first code (no page yet). */
  code: string | null;
  /** The start of the description, plain, cut at a word (null without one). */
  excerpt: string | null;
  terraceM2: number | null;
  agency: PortalAgency | null;
}

export interface PortalSearchInput {
  locale: string;
  /** Anywhere under any of these locations (a location page, a zone); none: everywhere. */
  locationIds?: readonly string[];
  query: PortalQuery;
  /** Counts per property type and location (location pages: the intro text and the child list). Engine only. */
  facets?: boolean;
  /** The zone a zone page searches (logged when its members exceed the search's limit). */
  zoneId?: string;
  requestId: string;
}

export interface PortalSearchPage {
  items: PortalCard[];
  /** Matching listings (exact up to 10,000; the fallback counts up to 1,000). */
  total: number;
  page: number;
  pageCount: number;
  /** Property type id → matching listings; location id → matching listings (empty from the fallback). */
  typeCounts: Readonly<Record<string, number>>;
  locationCounts: Readonly<Record<string, number>>;
  /** Answered by the Postgres fallback (no facets; deep pages unavailable for a while). */
  degraded: boolean;
  /** A numbered page past the first while the fallback answers (it pages by keyset only): no items. */
  pageUnavailable: boolean;
}

/** Excerpt length on a card. */
export const PORTAL_EXCERPT_CHARS = 220;

const SORTS: Record<PortalSort, 'newest' | 'price_asc' | 'price_desc'> = {
  latest: 'newest',
  price_asc: 'price_asc',
  price_desc: 'price_desc',
};

type PortalDoc = ListingCardDoc & { portalText?: string | null; portalTerraceM2?: number | null };

/** `PortalQuery` (+ the page's locations) → the website search's filters (types and features by the catalog). */
export function portalSearchFilters(
  catalog: PortalCatalog,
  q: PortalQuery,
  locationIds?: readonly string[],
): {
  propertyTypeIds?: string[];
  featureIds?: string[];
  locationIds?: string[];
  priceMinCents?: number;
  priceMaxCents?: number;
  bedsMin?: number;
  bedsMax?: number;
  bathsMin?: number;
  bathsMax?: number;
  areaMinM2?: number;
  /** A type or feature the visitor asked for that names nothing here: no listing can match. */
  impossible: boolean;
  /** Ids past the search's limits that were left out (the caller logs them): locations, property types. */
  cut: { locations: number; types: number };
} {
  const typeIds = typeIdsOf(catalog, q.type);
  const featureSets = q.feature.map((f) => catalog.features[f]);
  const featureIds = featureSets.flatMap((id) => (id ? [id] : []));
  return {
    propertyTypeIds: typeIds.length > 0 ? typeIds.slice(0, PORTAL_MAX_SEARCH_TYPES) : undefined,
    featureIds: featureIds.length > 0 ? featureIds : undefined,
    locationIds: locationIds && locationIds.length > 0 ? locationIds.slice(0, PORTAL_ZONE_MAX_MEMBERS) : undefined,
    priceMinCents: q.price_min !== undefined ? q.price_min * 100 : undefined,
    priceMaxCents: q.price_max !== undefined ? q.price_max * 100 : undefined,
    bedsMin: q.bedrooms_min,
    bedsMax: q.bedrooms_max,
    bathsMin: q.bathrooms_min,
    bathsMax: q.bathrooms_max,
    areaMinM2: q.build_min,
    impossible: (q.type.length > 0 && typeIds.length === 0) || featureSets.some((id) => id === undefined),
    cut: {
      locations: Math.max(0, (locationIds?.length ?? 0) - PORTAL_ZONE_MAX_MEMBERS),
      types: Math.max(0, typeIds.length - PORTAL_MAX_SEARCH_TYPES),
    },
  };
}

/** One numbered page of portal results. */
export async function portalSearch(input: PortalSearchInput): Promise<PortalSearchPage> {
  const locale = contentLocale(input.locale);
  const page = Math.min(Math.max(1, input.query.page ?? 1), PORTAL_MAX_PAGE);
  const sort = SORTS[input.query.sort ?? 'latest'];
  const catalog = await portalCatalog(locale);
  const { impossible, cut, ...filters } = portalSearchFilters(catalog, input.query, input.locationIds);
  if (cut.locations > 0 || cut.types > 0) {
    // Never silently: a zone with more members than a search takes shows only its first ones' listings.
    logger().warn(
      { zoneId: input.zoneId ?? null, locationsLeftOut: cut.locations, typesLeftOut: cut.types },
      'portal: search filter cut to its limits',
    );
  }
  const empty: PortalSearchPage = {
    items: [],
    total: 0,
    page,
    pageCount: 0,
    typeCounts: {},
    locationCounts: {},
    degraded: false,
    pageUnavailable: false,
  };
  if (impossible) return empty;
  const cursor = search.searchOffsetCursor(sort, (page - 1) * PORTAL_PAGE_SIZE);
  if (cursor === null) return empty;
  const inventory = await portalInventory(input.requestId);
  if (!inventory) return empty;
  const found = await search.searchPublicListings(inventory, {
    locale,
    // The portal lists homes for sale (rentals: R2).
    transactionType: 'SALE',
    ...filters,
    facets: input.facets ? ['propertyTypeId', 'locationIds'] : [],
    sort,
    limit: PORTAL_PAGE_SIZE,
    cursor,
  });
  const pageCount = Math.min(Math.ceil(found.total / PORTAL_PAGE_SIZE), PORTAL_MAX_PAGE);
  const counts = {
    typeCounts: found.facets.propertyTypeId ?? {},
    locationCounts: found.facets.locationIds ?? {},
  };
  // The fallback cannot continue an engine offset: it answered its own first page, not page N.
  if (found.resultsChanged) {
    return { ...empty, total: found.total, pageCount, ...counts, degraded: true, pageUnavailable: true };
  }
  const items = found.ids.length === 0 ? [] : await withPublicRead((tx) => portalCards(tx, found.ids, locale));
  return {
    items,
    total: found.total,
    page,
    pageCount,
    ...counts,
    degraded: found.backend === 'fallback',
    pageUnavailable: false,
  };
}

/** The cards of these listings in the search's order (a listing whose read model went in between is left out). */
async function portalCards(tx: Tx, ids: readonly string[], locale: ContentLocale): Promise<PortalCard[]> {
  const rows = await search.publicDocs(tx, ids, 'portal', locale, fallbackOf(locale));
  const byId = new Map(rows.map((r) => [r.targetId, r]));
  const ordered = ids.flatMap((id) => {
    const r = byId.get(id);
    return r && (r.doc as { kind?: string }).kind === 'LISTING' ? [r] : [];
  });
  const owners = await agenciesOf(
    tx,
    ordered.map((r) => r.ownerAgencyId),
  );
  return ordered.map((r) => {
    const doc = r.doc as PortalDoc;
    const agency = owners.get(r.ownerAgencyId) ?? null;
    const [card] = websites.serializeCards(ownView(r.ownerAgencyId, agency), [
      { ownerAgencyId: r.ownerAgencyId, publicCode: r.publicCode, doc },
    ]);
    const text = doc.portalText ? websites.plainText(doc.portalText).replace(/\s+/g, ' ').trim() : '';
    return {
      card: card as WebsiteListingCard,
      code: r.publicCode,
      excerpt: text ? websites.excerpt(text, PORTAL_EXCERPT_CHARS) : null,
      terraceM2: typeof doc.portalTerraceM2 === 'number' ? doc.portalTerraceM2 : null,
      agency,
    };
  });
}

// ── Listing page ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PortalListing {
  detail: Extract<ReturnType<typeof websites.serializeDetail>, { kind: 'LISTING' }>;
  code: string;
  agency: PortalAgency | null;
  updatedAt: Date;
  /** The public code of the listing's development (its portal page), null without one. */
  developmentCode: string | null;
}

/** The listing a public code names (any case), as the portal shows it; null: no such public listing. */
export async function portalListing(input: {
  locale: string;
  code: string;
  requestId: string;
}): Promise<PortalListing | null> {
  const code = input.code.toUpperCase();
  if (!PublicCode.safeParse(code).success) return null;
  const locale = contentLocale(input.locale);
  const inventory = await portalInventory(input.requestId);
  if (!inventory) return null;
  return withPublicRead(async (tx) => {
    const row = await search.publicDetailByCode(tx, inventory, code, locale, fallbackOf(locale));
    if (!row || (row.doc as { kind?: string }).kind !== 'LISTING') return null;
    const agency = (await agenciesOf(tx, [row.ownerAgencyId])).get(row.ownerAgencyId) ?? null;
    const detail = websites.serializeDetail(ownView(row.ownerAgencyId, agency), {
      ownerAgencyId: row.ownerAgencyId,
      publicCode: row.publicCode,
      doc: row.doc as ListingDetailDoc,
    });
    if (detail.kind !== 'LISTING') return null;
    return { detail, code, agency, updatedAt: row.updatedAt, developmentCode: row.developmentCode };
  });
}

// ── Development pages ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The portal's new-build inventory: every agency's PUBLIC units (units of OPEN developments) in the statuses sites show.
 * R1 lists units on their development's page only, not in the search.
 */
const developmentInventory = (requestId: string) => listedInventory(requestId);

/** Units a development page lists (the developer's order); more are counted, not listed (S15-02+: paging). */
export const PORTAL_DEVELOPMENT_UNITS = 100;

export interface PortalDevelopment {
  detail: ReturnType<typeof websites.serializeDevelopmentDetail>;
  code: string;
  agency: PortalAgency | null;
  updatedAt: Date;
  /** Its available and reserved units, at most `PORTAL_DEVELOPMENT_UNITS`. */
  units: ReturnType<typeof websites.serializeUnitCards>;
  /** More units than listed. */
  moreUnits: boolean;
}

/**
 * The new-build development a public code names (any case), with its unit table, as the portal shows it (its own
 * agency's: the developer's own reference and texts); null: none with public units. 2 statements (+1 for an agency not
 * cached).
 */
export async function portalDevelopment(input: {
  locale: string;
  code: string;
  requestId: string;
}): Promise<PortalDevelopment | null> {
  const code = input.code.toUpperCase();
  if (!PublicCode.safeParse(code).success) return null;
  const locale = contentLocale(input.locale);
  const fallback = fallbackOf(locale);
  const inventory = await developmentInventory(input.requestId);
  if (!inventory) return null;
  return withPublicRead(async (tx) => {
    const row = await search.developmentByCode(tx, inventory, code, locale, fallback);
    if (!row) return null;
    const page = await search.developmentUnitsByCode(tx, inventory, {
      code,
      limit: PORTAL_DEVELOPMENT_UNITS,
      locale,
      fallback,
    });
    const agency = (await agenciesOf(tx, [row.ownerAgencyId])).get(row.ownerAgencyId) ?? null;
    const view = ownView(row.ownerAgencyId, agency);
    const rows = page.rows.slice(0, PORTAL_DEVELOPMENT_UNITS);
    return {
      detail: websites.serializeDevelopmentDetail(view, { ...row, doc: row.doc as UnitDetailDoc }),
      code,
      agency,
      updatedAt: row.updatedAt,
      units: websites.serializeUnitCards(
        view,
        rows.map((r) => ({
          ownerAgencyId: r.ownerAgencyId,
          publicCode: r.publicCode,
          developmentCode: r.developmentCode,
          developmentOwnRef: r.developmentOwnRef,
          doc: r.doc as UnitCardDoc,
        })),
      ),
      moreUnits: page.rows.length > PORTAL_DEVELOPMENT_UNITS,
    };
  });
}
