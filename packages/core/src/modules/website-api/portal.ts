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
 * 1 (documents) + 1 when an agency on the page is not cached (published profiles, cached here for a minute) + 1 when
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
import {
  type ContentLocale,
  DEFAULT_CONTENT_LOCALE,
  FALLBACK_CONTENT_LOCALE,
  isContentLocale,
  UI_LOCALES,
} from '@inmolink/i18n';
import { LocalLru } from '@inmolink/platform/cache';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import * as agencies from '../agencies';
import * as search from '../search';
import * as taxonomy from '../taxonomy';
import * as websites from '../websites';
import { FEATURE_CONCEPTS } from './ai-search-parse';
import {
  agencyPath,
  codeOfSlug,
  developmentNameOf,
  developmentPath,
  listingPath,
  portalListingTitle,
} from './portal-urls';
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
 * the listed ones) to leave out, whichever set is smaller (production: a few unlisted owners). Refreshed in the
 * background while the old set answers once it is `OWNER_SCOPE_REFRESH_MS` old, so a busy process pays the two
 * statements off the request path; never used older than `OWNER_SCOPE_MAX_AGE_MS` (an idle process waits for the
 * reload), so an agency's change of standing shows within a minute — S15-F7: the portal page cache's agency settle
 * (`PORTAL_AGENCY_SETTLE_MS`) relies on that bound.
 */
const OWNER_SCOPE_REFRESH_MS = 45_000;
export const OWNER_SCOPE_MAX_AGE_MS = 60_000;

/** Whose documents the portal shows: the listed agencies, or everyone but the unlisted owners. */
export type OwnerScope = { show: string[] } | { hide: string[] };

/**
 * The smaller of the two lists, as long as the hide list fits a search (`MAX_EXCLUDED_OWNERS`). A hide list that would
 * be cut short is never used — the owners past the cut would show unlisted stock — so it falls back to a show list;
 * a show list cut short only leaves listed agencies out (logged).
 */
export function ownerScopeOf(listed: readonly string[], hide: readonly string[]): OwnerScope {
  const max = search.MAX_EXCLUDED_OWNERS;
  if (hide.length <= listed.length && hide.length <= max) return { hide: [...hide] };
  if (listed.length > max) {
    logger().error(
      { listed: listed.length, unlisted: hide.length, max },
      'portal: too many owners to name in a search; showing the first listed agencies only',
    );
  }
  return { show: listed.slice(0, max) };
}

let ownerScope: { scope: OwnerScope; at: number } | undefined;
let ownerScopeLoad: Promise<OwnerScope> | undefined;

function loadOwnerScope(): Promise<OwnerScope> {
  ownerScopeLoad ??= withPublicRead(async (tx) => {
    const listed = await agencies.listedAgencyIds(tx);
    const listedSet = new Set(listed);
    const hide = (await search.searchDocOwners(tx)).filter((o) => !listedSet.has(o));
    return ownerScopeOf(listed, hide);
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

/** The owner scope (cached; the previous one answers while it refreshes, up to `OWNER_SCOPE_MAX_AGE_MS`). */
async function currentOwnerScope(): Promise<OwnerScope> {
  const age = ownerScope ? Date.now() - ownerScope.at : Number.POSITIVE_INFINITY;
  if (ownerScope && age < OWNER_SCOPE_REFRESH_MS) return ownerScope.scope;
  const next = loadOwnerScope();
  if (!ownerScope || age >= OWNER_SCOPE_MAX_AGE_MS) return next;
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
export const portalInventory = (requestId: string) => listedInventory(requestId, { restrict: { newBuilds: false } });

/**
 * S15-03: one agency's PUBLIC listings (its profile page), or null when the cached owner scope leaves the agency out
 * (not listed now — the same set every portal page uses, so its stock is on its page exactly when it is in the search).
 */
async function agencyInventory(agencyId: string, requestId: string): Promise<search.PublicSearchSite | null> {
  const scope = await currentOwnerScope();
  const shown = 'show' in scope ? scope.show.includes(agencyId) : !scope.hide.includes(agencyId);
  return shown ? { ownerAgencyIds: [agencyId], restrict: { newBuilds: false }, requestId } : null;
}

/** A content locale for `locale` (UI locales are content locales; anything else reads the default). */
export const contentLocale = (locale: string): ContentLocale =>
  isContentLocale(locale) ? locale : DEFAULT_CONTENT_LOCALE;
/** The locale a document falls back to when it has none in the page's. */
export const fallbackOf = (locale: ContentLocale): string =>
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

export interface PlaceNode extends PortalPlace {
  parentId: string | null;
  childIds: string[];
}

export interface PlaceIndex {
  byId: Map<string, PlaceNode>;
  roots: PlaceNode[];
  zones: Map<string, { id: string; name: string; slug: string; locationIds: string[] }>;
  zoneById: Map<string, { slug: string }>;
}

type TreeNode = { id: string; level: string; name: string; slug: string; children?: TreeNode[] };

/** Built indexes per locale with the tree ETag they were built from (a taxonomy edit brings a new tree). */
const placeIndexes = new Map<string, { etag: string; index: PlaceIndex }>();

export async function placeIndex(locale: ContentLocale): Promise<PlaceIndex> {
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

/**
 * Published profiles by agency id; null: not listed (unverified or left the directory) — no agency is named. S15-F7:
 * kept a minute (was 5), so a contact change shows on search pages within a minute and the portal page cache's agency
 * settle (`PORTAL_AGENCY_SETTLE_MS`) outlasts it. A miss costs one statement for every agency missing on the page.
 */
const agencyCache = new LocalLru<PortalAgency | null>(10_000);
const AGENCY_TTL_MS = 60_000;
const UNLISTED_TTL_MS = 60_000;

/** Tests: forget cached agencies. */
export function resetPortalCaches(): void {
  agencyCache.clear();
  profileCache.clear();
  profileMisses.clear();
  placeIndexes.clear();
  knownCodes.clear();
  unknownCodes.clear();
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
export const ownView = (ownerAgencyId: string, agency: PortalAgency | null): websites.SiteView => ({
  site: { agencyId: ownerAgencyId, referencePrefix: null },
  presenter: presenterOf(agency),
  mediaBaseUrl: configured().mediaBaseUrl,
});

// ── Agency profiles (S15-03) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A listed agency's profile page as the portal shows it: its directory name and kind, the contact details it publishes,
 * the register number, languages and town it states, and its tagline and about text (in the page's locale, else the
 * fallback's: `textLocale` says which). Never its tax id, address, settings, commission, members or notes.
 */
export interface PortalAgencyProfile extends PortalAgency {
  kind: 'AGENCY' | 'DEVELOPER' | 'PARTNER';
  registerNumber: string | null;
  /** Content locale codes the agency works in. */
  languages: string[];
  city: string | null;
  tagline: string | null;
  description: string | null;
  /** The locale of `tagline` / `description` (null without either). */
  textLocale: string | null;
  /** Its page in every UI locale (`portalAgencyPaths`): canonical, alternates, sitemaps, legacy redirects. */
  paths: Record<string, string>;
}

/**
 * Profiles by content locale and agency id. A change of standing or profile shows within a minute. Misses (not listed,
 * unknown ids) are kept apart in a small LRU of their own, so made-up ids in URLs cannot evict real profiles.
 */
const profileCache = new LocalLru<PortalAgencyProfile>(5_000);
const profileMisses = new LocalLru<true>(1_000);
const PROFILE_TTL_MS = 60_000;
const AGENCY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** S15-03: whether `id` can name an agency (a UUID, any case) — the one check the profile reads and enquiries use. */
export const isPortalAgencyId = (id: string): boolean => AGENCY_ID.test(id);

/** S15-03: an agency's profile URL in every UI locale (one name for all: its directory name). */
export function portalAgencyPaths(
  agency: { id: string; name: string },
  locales: readonly string[] = UI_LOCALES,
): Record<string, string> {
  return Object.fromEntries(locales.map((l) => [l, agencyPath(l, agency.id, agency.name)]));
}

/**
 * S15-03: the listed agency `id` names, as its profile page shows it; null: not a listed agency (unverified, suspended,
 * opted out, unknown, or not an id). Cached per process for a minute; a miss costs one statement (`app_public`), and
 * primes the listing-agency cache, so the page's cards cost none.
 */
export async function portalAgency(locale: string, id: string): Promise<PortalAgencyProfile | null> {
  if (!isPortalAgencyId(id)) return null;
  const agencyId = id.toLowerCase();
  const l = contentLocale(locale);
  const key = `${l}|${agencyId}`;
  const hit = profileCache.get(key);
  if (hit !== undefined) return hit;
  if (profileMisses.get(key)) return null;
  const locales = [...new Set([l, fallbackOf(l), DEFAULT_CONTENT_LOCALE])];
  const row = await withPublicRead((tx) => agencies.publicAgencyProfile(tx, agencyId, locales));
  const profile: PortalAgencyProfile | null = row
    ? {
        id: agencyId,
        name: row.name,
        email: row.contactEmail,
        phone: row.contactPhone,
        website: row.websiteUrl,
        kind: row.kind,
        registerNumber: row.registerNumber,
        languages: row.languages.filter(isContentLocale),
        city: row.city,
        tagline: row.tagline,
        description: row.description,
        textLocale: row.tagline || row.description ? row.textLocale : null,
        paths: portalAgencyPaths({ id: agencyId, name: row.name }),
      }
    : null;
  if (!profile) {
    profileMisses.set(key, true, PROFILE_TTL_MS);
    return null;
  }
  profileCache.set(key, profile, PROFILE_TTL_MS);
  const { name, email, phone, website } = profile;
  agencyCache.set(agencyId, { id: agencyId, name, email, phone, website }, AGENCY_TTL_MS);
  return profile;
}

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
  /** S15-03: only this agency's listings (its profile page); none while the agency is not listed. */
  agencyId?: string;
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
  // S15-03 review: an agency's listings only while it has a listed profile (cached: the page read it first) AND the
  // cached owner scope shows it — a hide-list scope alone would let an agency with no stock through.
  const agency = input.agencyId ? await portalAgency(input.locale, input.agencyId) : undefined;
  if (agency === null) return empty;
  const inventory = agency ? await agencyInventory(agency.id, input.requestId) : await portalInventory(input.requestId);
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

/** What a listing's portal URL is made of: its type and place (ids and names). */
export interface PortalNamed {
  propertyType: { id: string; name: string };
  place: Partial<Record<'country' | 'region' | 'city' | 'area', { id: string; name: string } | null>>;
}

/** Type names by id per taxonomy catalog (the catalog object is replaced when the taxonomy changes). */
const typeNameMaps = new WeakMap<object, Map<string, string>>();

/**
 * S15-02: `doc`'s type and place named in `locale`'s taxonomy, by id. Read models exist only in the owner's content
 * locales, so an English page of a Spanish-only agency reads the Spanish row: its names are replaced here, so every
 * locale's page, title, canonical and the sitemap name a listing in that locale. A name the taxonomy does not have in
 * the locale keeps the document's. Cached taxonomy only: no statement.
 */
export async function localizedListingNames<T extends PortalNamed>(locale: string, doc: T): Promise<T> {
  const l = contentLocale(locale);
  const { catalog } = await taxonomy.websiteTaxonomyObjects(l);
  let types = typeNameMaps.get(catalog.body);
  if (!types) {
    types = new Map(catalog.body.propertyTypes.flatMap((g) => g.types.map((t) => [t.id, t.name] as const)));
    typeNameMaps.set(catalog.body, types);
  }
  const index = await placeIndex(l);
  const place = { ...doc.place };
  for (const k of ['country', 'region', 'city', 'area'] as const) {
    const p = place[k];
    const name = p ? index.byId.get(p.id)?.name : undefined;
    if (p && name) place[k] = { ...p, name };
  }
  const typeName = types.get(doc.propertyType.id);
  return {
    ...doc,
    propertyType: typeName ? { ...doc.propertyType, name: typeName } : doc.propertyType,
    place,
  };
}

/**
 * S15-02: a listing's portal URL in every UI locale — the one helper for its page's canonical and hreflang alternates
 * and for the sitemaps, so they never disagree. "<Type> in <Town>" from each locale's taxonomy names.
 */
export async function portalListingPaths(
  doc: PortalNamed,
  code: string,
  locales: readonly string[] = UI_LOCALES,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const l of locales) out[l] = listingPath(l, portalListingTitle(l, await localizedListingNames(l, doc)), code);
  return out;
}

/**
 * S15-02: a development's portal URL in every UI locale (page canonical, alternates, sitemaps): one name for all — the
 * developer's name (its marketing title without one).
 */
export function portalDevelopmentPaths(
  d: { name: string; title: string },
  code: string,
  locales: readonly string[] = UI_LOCALES,
): Record<string, string> {
  return Object.fromEntries(locales.map((l) => [l, developmentPath(l, developmentNameOf(d), code)]));
}

export interface PortalListing {
  /** Type and place named in the page's locale (`localizedListingNames`). */
  detail: Extract<ReturnType<typeof websites.serializeDetail>, { kind: 'LISTING' }>;
  code: string;
  agency: PortalAgency | null;
  updatedAt: Date;
  /** The public code of the listing's development (its portal page), null without one. */
  developmentCode: string | null;
  /** S15-02: its URL in every UI locale (`portalListingPaths`): the page's canonical and alternates. */
  paths: Record<string, string>;
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
  const found = await withPublicRead(async (tx) => {
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
  if (!found) return null;
  // Named in the page's own locale, whichever locale's read model answered (S15-02).
  const detail = await localizedListingNames(input.locale, found.detail);
  return { ...found, detail, paths: await portalListingPaths(found.detail, code) };
}

// ── Listing and development page gate ───────────────────────────────────────────────────────────────────────────

/** How long a code known to exist / not to exist is remembered per process. */
export const PORTAL_KNOWN_CODE_TTL_MS = 10 * 60_000;
export const PORTAL_UNKNOWN_CODE_TTL_MS = 60_000;
/** Remembered codes per process (bounded apart, so made-up codes never evict real ones). */
const knownCodes = new LocalLru<true>(100_000);
const unknownCodes = new LocalLru<true>(10_000);

/**
 * S15 review: the proxy's gate for a listing or development page (`/…/property/<slug>`, `/…/development/<slug>`).
 * A slug whose public code is known to exist passes at once — real pages are never limited, and their ISR copies are
 * served as before. Anything else costs the client one unit of its page limit first (`beforeProbe`, false: `limited`):
 * a slug without a code, a code remembered as unknown, or a code not seen yet — then one unique-index probe
 * (`listing_public_codes`, listings and developments alike). So a flood of made-up codes is cut off per client before
 * it renders 404s or probes the legacy redirects. A known code may still name nothing the portal shows (withdrawn, an
 * unlisted agency's): the page answers its 404, cached apart from the pages. An unknown code is remembered a minute, so
 * a code given out meanwhile soon passes.
 */
export async function portalPageCode(
  slug: string,
  beforeProbe: () => Promise<boolean>,
): Promise<'known' | 'unknown' | 'limited'> {
  const code = codeOfSlug(slug);
  if (code && knownCodes.get(code)) return 'known';
  if (!(await beforeProbe())) return 'limited';
  if (!code || unknownCodes.get(code)) return 'unknown';
  const known = await withPublicRead((tx) => search.publicCodeInUse(tx, code));
  if (known) knownCodes.set(code, true, PORTAL_KNOWN_CODE_TTL_MS);
  else unknownCodes.set(code, true, PORTAL_UNKNOWN_CODE_TTL_MS);
  return known ? 'known' : 'unknown';
}

/**
 * S15-02: the listing a public code names among the portal's stock — what the enquiry form needs: its id, its owner
 * (who holds the lead) and the owner's own reference. One statement; null: not on the portal.
 */
export async function portalListingTarget(
  code: string,
  locale: string,
  requestId: string,
): Promise<{ targetId: string; ownerAgencyId: string; ref: string } | null> {
  if (!PublicCode.safeParse(code).success) return null;
  const l = contentLocale(locale);
  const inventory = await portalInventory(requestId);
  if (!inventory) return null;
  const row = await withPublicRead((tx) => search.publicDetailByCode(tx, inventory, code, l, fallbackOf(l)));
  const doc = row?.doc as { kind?: string; ref?: string } | undefined;
  if (!row || doc?.kind !== 'LISTING' || typeof doc.ref !== 'string') return null;
  return { targetId: row.targetId, ownerAgencyId: row.ownerAgencyId, ref: doc.ref };
}

// ── Development pages ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The portal's new-build inventory: every agency's PUBLIC units (units of OPEN developments) in the statuses sites show.
 * R1 lists units on their development's page only, not in the search.
 */
export const developmentInventory = (requestId: string) => listedInventory(requestId);

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
  /** S15-02: its URL in every UI locale (`portalDevelopmentPaths`): the page's canonical and alternates. */
  paths: Record<string, string>;
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
    const detail = websites.serializeDevelopmentDetail(view, { ...row, doc: row.doc as UnitDetailDoc });
    return {
      detail,
      code,
      paths: portalDevelopmentPaths(detail, code),
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
