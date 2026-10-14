/**
 * Localized taxonomy reads (S2-03, PLAN §7 M4, PATTERNS §15): the location tree with location groups,
 * and the property type / feature catalog, for the dashboard UI and the website API.
 *
 * Two cache entries per locale under global keys (the data is the same for every agency), tag `taxonomy`,
 * in redis-cache for an hour and in-process for 60 s: `locations` (2 statements cold) and `catalog`
 * (1 statement). Every write emits `taxonomy.data.changed`; its subscriber bumps the tag. Warm reads run
 * no query.
 *
 * The website API never sends the whole tree (a Spain-sized one is ~330 KB gzip; budget 150 KB): it
 * serves countries with regions, then one location's children per request — all cut from the cached
 * tree, serialized once per cached copy (memoized on the in-process value) with a strong ETag.
 */
import type {
  LocationLevel,
  TaxonomyCatalogDto,
  TaxonomyCountry,
  TaxonomyDto,
  TaxonomyLocationsDto,
  WebsiteLocationChildrenDto,
  WebsiteLocationsDto,
} from '@inmolink/contracts';
import { type Tx, withPublicRead } from '@inmolink/db';
import { type ContentLocale, DEFAULT_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { type CacheKey, cache, cacheKey } from '@inmolink/platform/cache';
import { AppError } from '@inmolink/platform/errors';
import { etagFor } from '@inmolink/platform/http';
import type { Ctx } from '../../context';
import { assertCan } from './policy';
import * as repo from './repo';

export const TAXONOMY_CACHE_TAG = 'taxonomy';
export const TAXONOMY_CACHE_TTL_SECONDS = 3_600;

/** A body with its strong ETag. */
export interface Tagged<T> {
  etag: string;
  body: T;
}

/** A website API response body, serialized once, with its strong ETag. */
export interface Serialized {
  etag: string;
  json: string;
}

export function taxonomyCacheKey(entity: 'locations' | 'catalog', locale: ContentLocale): CacheKey {
  return cacheKey({ v: 1, module: 'taxonomy', entity, scope: 'global', locale });
}

/** `taxonomy.data.changed` subscriber: the next read misses everywhere. */
export async function invalidateTaxonomyCache(): Promise<void> {
  await cache.invalidateTag(TAXONOMY_CACHE_TAG);
}

function tagged<T>(key: CacheKey, load: () => Promise<T>): Promise<Tagged<T>> {
  return cache.get(
    key,
    { ttlSeconds: TAXONOMY_CACHE_TTL_SECONDS, tags: [TAXONOMY_CACHE_TAG], local: true },
    async () => {
      const body = await load();
      return { etag: etagFor(JSON.stringify(body)), body };
    },
  );
}

function serialize(body: unknown): Serialized {
  const json = JSON.stringify(body);
  return { etag: etagFor(json), json };
}

// ---- Loaders (cache misses only) ------------------------------------------------------------------------------

type Sortable = { sort: number; key: string };
const bySortThenKey = (a: Sortable, b: Sortable) => a.sort - b.sort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

type Node = { id: string; level: string; code: string | null; name: string; slug: string; children?: Node[] };

async function loadLocations(tx: Tx, locale: ContentLocale): Promise<TaxonomyLocationsDto> {
  const rows = await repo.localizedLocations(tx, locale);
  const groups = await repo.localizedLocationGroups(tx, locale);

  // Siblings sorted by name in the locale's collation; the depth CHECK and parent FK guarantee the tree.
  const collator = new Intl.Collator(locale);
  rows.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
  const nodes = new Map<string, Node>();
  for (const r of rows) {
    const { id, level, code, name, slug } = r;
    nodes.set(id, { id, level, code, name, slug, ...(r.depth < 4 ? { children: [] } : {}) });
  }
  const roots: Node[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id) as Node;
    if (r.parentId === null) roots.push(node);
    else nodes.get(r.parentId)?.children?.push(node);
  }

  groups.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
  return { locale, locations: roots as TaxonomyCountry[], locationGroups: groups };
}

async function loadCatalog(tx: Tx, locale: ContentLocale): Promise<TaxonomyCatalogDto> {
  const rows = (await repo.localizedCatalog(tx, locale)).sort(bySortThenKey);
  const item = (r: repo.CatalogRow) => ({ id: r.id, key: r.key, name: r.name, slug: r.slug });
  const typeGroups = new Map<string, TaxonomyCatalogDto['propertyTypes'][number]>();
  const featureGroups = new Map<string, TaxonomyCatalogDto['features'][number]>();
  // Groups first, so every item finds its group (a group FK is NOT NULL).
  for (const r of rows) {
    if (r.kind === 'TYPE_GROUP') typeGroups.set(r.id, { ...item(r), types: [] });
    else if (r.kind === 'FEATURE_GROUP') featureGroups.set(r.id, { ...item(r), features: [] });
  }
  for (const r of rows) {
    if (r.kind === 'TYPE') typeGroups.get(r.group_id as string)?.types.push(item(r));
    else if (r.kind === 'FEATURE')
      featureGroups.get(r.group_id as string)?.features.push({ ...item(r), icon: r.icon ?? '' });
  }
  return { locale, propertyTypes: [...typeGroups.values()], features: [...featureGroups.values()] };
}

const locationsOf = (locale: ContentLocale, tx?: Tx) =>
  tagged(taxonomyCacheKey('locations', locale), () =>
    tx ? loadLocations(tx, locale) : withPublicRead((t) => loadLocations(t, locale)),
  );
const catalogOf = (locale: ContentLocale, tx?: Tx) =>
  tagged(taxonomyCacheKey('catalog', locale), () =>
    tx ? loadCatalog(tx, locale) : withPublicRead((t) => loadCatalog(t, locale)),
  );

// ---- Dashboard -----------------------------------------------------------------------------------------------

/** The UI locale when it is a content locale, else the default content locale. */
function ctxLocale(ctx: Ctx): ContentLocale {
  return isContentLocale(ctx.locale) ? ctx.locale : DEFAULT_CONTENT_LOCALE;
}

/**
 * `GET /v1/taxonomy`: the whole taxonomy in the caller's locale (any member, Client Mode too), with an
 * ETag over both cache entries.
 */
export async function getTaxonomyDocument(ctx: Ctx): Promise<Tagged<TaxonomyDto>> {
  assertCan(ctx, 'taxonomy.read');
  const locale = ctxLocale(ctx);
  // Sequential: both loaders share the request's transaction (one connection).
  const locations = await locationsOf(locale, ctx.tx);
  const catalog = await catalogOf(locale, ctx.tx);
  return { etag: etagFor(locations.etag + catalog.etag), body: { ...locations.body, ...catalog.body } };
}

/** The whole localized taxonomy, for other modules. ≤ 3 statements cold, none warm. */
export async function getTaxonomy(ctx: Ctx): Promise<TaxonomyDto> {
  return (await getTaxonomyDocument(ctx)).body;
}

// ---- Website API ---------------------------------------------------------------------------------------------
// No `ctx`: platform reference data, the same for every site, read under `app_public` after
// `requireApiKey('taxonomy:read')` (CLAUDE.md rule 4 exception, like `authenticateApiKey`).

/** `?lang=`: absent → the default content locale; not a content locale → 422 (cache keys stay bounded). */
function websiteLocale(lang: string | undefined): ContentLocale {
  if (lang === undefined) return DEFAULT_CONTENT_LOCALE;
  if (!isContentLocale(lang)) throw new AppError('VALIDATION_FAILED', { field: 'lang' });
  return lang;
}

/** Serialized cuts of one cached tree. Keyed by the cached value: a reload (new object) starts afresh. */
interface Cuts {
  top?: Serialized;
  index?: Map<string, Node>;
  children: Map<string, Serialized>;
}
const cutsOf = new WeakMap<object, Cuts>();
const catalogJson = new WeakMap<object, Serialized>();

function cuts(body: object): Cuts {
  let c = cutsOf.get(body);
  if (!c) {
    c = { children: new Map() };
    cutsOf.set(body, c);
  }
  return c;
}

const flat = (n: Node) => ({
  id: n.id,
  level: n.level as LocationLevel,
  code: n.code,
  name: n.name,
  slug: n.slug,
  childCount: n.children?.length ?? 0,
});

/** `GET /v2/taxonomy/locations`: countries with their regions, and the location groups. */
export async function getWebsiteLocations(lang?: string): Promise<Serialized> {
  const locale = websiteLocale(lang);
  const { body } = await locationsOf(locale);
  const c = cuts(body);
  c.top ??= serialize({
    locale,
    locations: (body.locations as Node[]).map((country) => ({
      ...flat(country),
      children: (country.children ?? []).map(flat),
    })),
    locationGroups: body.locationGroups,
  } satisfies WebsiteLocationsDto);
  return c.top;
}

/** `GET /v2/taxonomy/locations/:id/children`: one location's direct children. Unknown id → 404. */
export async function getWebsiteLocationChildren(id: string, lang?: string): Promise<Serialized> {
  const locale = websiteLocale(lang);
  const { body } = await locationsOf(locale);
  const c = cuts(body);
  if (!c.index) {
    const index = new Map<string, Node>();
    const walk = (n: Node) => {
      index.set(n.id, n);
      for (const child of n.children ?? []) walk(child);
    };
    for (const country of body.locations as Node[]) walk(country);
    c.index = index;
  }
  const node = c.index.get(id);
  if (!node) throw new AppError('LOCATION_NOT_FOUND');
  let doc = c.children.get(id);
  if (!doc) {
    doc = serialize({
      locale,
      parentId: id,
      children: (node.children ?? []).map(flat),
    } satisfies WebsiteLocationChildrenDto);
    c.children.set(id, doc);
  }
  return doc;
}

/** `GET /v2/taxonomy/catalog`: property types and features. */
export async function getWebsiteCatalog(lang?: string): Promise<Serialized> {
  const { body } = await catalogOf(websiteLocale(lang));
  let doc = catalogJson.get(body);
  if (!doc) {
    doc = serialize(body);
    catalogJson.set(body, doc);
  }
  return doc;
}
