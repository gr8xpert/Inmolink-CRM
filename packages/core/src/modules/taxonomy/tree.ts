/**
 * Localized taxonomy reads (S2-03, PLAN §7 M4, PATTERNS §15): the location tree with location groups,
 * and the property type / feature catalog, for the dashboard UI and the website API.
 *
 * Per locale, under global keys (the data is the same for every agency), tag `taxonomy`, in redis-cache for an
 * hour and in-process for 60 s: the `locations` tree and the `catalog` (objects, for other modules), and the
 * response bodies already serialized with their strong ETag (S3-F2) — `document` (`GET /v1/taxonomy`, never stale),
 * `webtop` (countries with regions; it also names the tree's ETag) and `webcatalog`. A Redis hit of those
 * parses one string and serializes nothing. Children pages are content-addressed by the tree's ETag
 * (`webchildren`, untagged): a page cut from one tree is valid for as long as anyone asks for that tree.
 * Every write emits `taxonomy.data.changed`; its subscriber bumps the tag. Warm reads run no query.
 *
 * While one reload runs, this process keeps serving its previous copy of a website body (`fresh` below), so a
 * tag bump never makes every request wait on the database; the cold reload reads two locales (S3-F2).
 *
 * The website API never sends the whole tree (a Spain-sized one is ~330 KB gzip; budget 150 KB): it serves
 * countries with regions, then one location's children per request, paged by size (`CHILDREN_PAGE_BYTES`).
 */
import type {
  LocationLevel,
  StaffTaxonomyDto,
  TaxonomyCatalogDto,
  TaxonomyCountry,
  TaxonomyDto,
  TaxonomyLocationsDto,
  WebsiteLocationsDto,
} from '@inmolink/contracts';
import { type Tx, withPublicRead, withTenant } from '@inmolink/db';
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

type Entity = 'locations' | 'catalog' | 'document' | 'webtop' | 'webcatalog' | 'webchildren';

export function taxonomyCacheKey(entity: Entity, locale: ContentLocale, id?: string): CacheKey {
  return cacheKey({ v: 1, module: 'taxonomy', entity, scope: 'global', locale, ...(id ? { id } : {}) });
}

/** `taxonomy.data.changed` subscriber: the next read misses everywhere; this process drops its previous copies. */
export async function invalidateTaxonomyCache(): Promise<void> {
  dropPrevious();
  await cache.invalidateTag(TAXONOMY_CACHE_TAG);
}

/** Drops this process's copies (in-process cache and previous bodies) — for tests, like `cache.clearLocal()`. */
export function dropLocalTaxonomyCopies(): void {
  dropPrevious();
  cache.clearLocal();
}

const CACHED = { ttlSeconds: TAXONOMY_CACHE_TTL_SECONDS, tags: [TAXONOMY_CACHE_TAG], local: true } as const;

/** This process's last copy of each serialized body, served while its reload runs (S3-F2). Few keys per locale. */
const previous = new Map<string, Serialized>();
/** Bumped on every clear: a reload that started before it must not write its body back as the previous copy. */
let generation = 0;
function dropPrevious(): void {
  generation++;
  previous.clear();
}

/**
 * Read-through for a serialized body. With a previous copy, a value not ready by the next macrotask (a Redis
 * round trip, or a reload from the database) is answered with that copy and lands for the next request; the
 * cache's single-flight keeps it to one reload per process. A loader must never read through `fresh` itself:
 * it would store a stale copy under the new tag version.
 */
function fresh<T extends Serialized>(key: CacheKey, load: () => Promise<T>): Promise<T> {
  const started = generation;
  const next = cache.get(key, CACHED, load).then((doc) => {
    if (generation === started) previous.set(key, doc);
    return doc;
  });
  const old = previous.get(key) as T | undefined;
  if (!old) return next;
  next.catch(() => undefined); // a failed background reload keeps the previous copy; the next request retries
  return Promise.race([next, new Promise<T>((resolve) => setImmediate(() => resolve(old)))]);
}

/**
 * `local: false` for reads inside another entry's loader (S3-F2): the in-process copy may predate a tag bump
 * made by another process, and a body built from it would be stored under the new version for an hour.
 */
function tagged<T>(key: CacheKey, load: () => Promise<T>, local = true): Promise<Tagged<T>> {
  return cache.get(key, { ...CACHED, local }, async () => {
    const body = await load();
    return { etag: etagFor(JSON.stringify(body)), body };
  });
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
  return buildLocationTree(locale, rows, groups);
}

/** Nests the rows into the tree (pure; the perf test times it with the statement). */
export function buildLocationTree(
  locale: ContentLocale,
  rows: repo.LocalizedLocationRow[],
  groups: TaxonomyLocationsDto['locationGroups'],
): TaxonomyLocationsDto {
  // The depth CHECK and parent FK guarantee the tree. Siblings are sorted per parent (staff order `sort`, S2-04,
  // then the name in the locale's collation): many short sorts compare far less than one over every row (S3-F2).
  const nodes = new Map<string, Node>();
  const order = new Map<Node, number>();
  for (const r of rows) {
    const { id, level, code, name, slug } = r;
    const node: Node = { id, level, code, name, slug, ...(r.depth < 4 ? { children: [] } : {}) };
    nodes.set(id, node);
    order.set(node, r.sort);
  }
  const roots: Node[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id) as Node;
    if (r.parentId === null) roots.push(node);
    else nodes.get(r.parentId)?.children?.push(node);
  }
  const collator = new Intl.Collator(locale);
  const bySibling = (a: Node, b: Node) =>
    (order.get(a) as number) - (order.get(b) as number) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);
  const sortAll = (list: Node[]) => {
    list.sort(bySibling);
    for (const n of list) if (n.children && n.children.length > 0) sortAll(n.children);
  };
  sortAll(roots);

  const sorted = [...groups].sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
  return { locale, locations: roots as TaxonomyCountry[], locationGroups: sorted };
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

/**
 * Runs a cache miss's statements. The website API reads as `app_public`; a dashboard request in its own
 * transaction; the dashboard document, which the cache may share between requests, in a transaction of its own
 * under the caller's agency (`app_user` reads the global tables; the api process has no `app_public`).
 */
type Reader = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const publicReader: Reader = (fn) => withPublicRead(fn);
const txReader =
  (tx: Tx): Reader =>
  (fn) =>
    fn(tx);
const agencyReader =
  (agencyId: string): Reader =>
  (fn) =>
    withTenant({ agencyId }, fn);

const locationsOf = (locale: ContentLocale, read: Reader = publicReader, local = true) =>
  tagged(taxonomyCacheKey('locations', locale), () => read((tx) => loadLocations(tx, locale)), local);
const catalogOf = (locale: ContentLocale, read: Reader = publicReader, local = true) =>
  tagged(taxonomyCacheKey('catalog', locale), () => read((tx) => loadCatalog(tx, locale)), local);
/** Inside a loader: the current version from Redis (or the database), never this process's possibly old copy. */
const currentLocations = (locale: ContentLocale, read: Reader = publicReader) => locationsOf(locale, read, false);
const currentCatalog = (locale: ContentLocale, read: Reader = publicReader) => catalogOf(locale, read, false);

// ---- Dashboard -----------------------------------------------------------------------------------------------

/** The UI locale when it is a content locale, else the default content locale. */
function ctxLocale(ctx: Ctx): ContentLocale {
  return isContentLocale(ctx.locale) ? ctx.locale : DEFAULT_CONTENT_LOCALE;
}

/**
 * `GET /v1/taxonomy`: the whole taxonomy in the caller's locale (any member, Client Mode too), serialized once
 * per tree (S3-F2) with its strong ETag.
 */
export async function getTaxonomyDocument(ctx: Ctx): Promise<Serialized> {
  assertCan(ctx, 'taxonomy.read');
  const locale = ctxLocale(ctx);
  // Not `fresh`: an agent must see a staff edit on the next load (a form listing the new type), and the dashboard
  // is not the website's request rate. Its own transaction all the same: the cache's single-flight may run this
  // loader for another request.
  return cache.get(taxonomyCacheKey('document', locale), CACHED, async () => {
    const read = agencyReader(ctx.tenant.agencyId);
    const locations = await currentLocations(locale, read);
    const catalog = await currentCatalog(locale, read);
    return serialize({ ...locations.body, ...catalog.body } satisfies TaxonomyDto);
  });
}

type Located = repo.LocalizedLocationRow & { childCount: number };

/** Staff order (`sort`), then the localized name, then id — the order every reader shows siblings in. */
function bySiblingOrder(locale: ContentLocale) {
  const collator = new Intl.Collator(locale);
  return (a: { sort: number; name: string; id: string }, b: { sort: number; name: string; id: string }) =>
    a.sort - b.sort || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);
}

const staffFlat = (r: Located) => ({
  id: r.id,
  level: r.level as LocationLevel,
  code: r.code,
  name: r.name,
  slug: r.slug,
  childCount: r.childCount,
});

/**
 * The staff editor's first view straight from the database (S2-04, S3-F2): countries with regions, groups and
 * the catalog — it must show an edit the moment it is saved, so it skips the cache. Cities and areas load on
 * expand (`loadStaffChildren`), so the editor never reads the whole tree. Four statements.
 */
export async function loadStaffTop(tx: Tx, locale: ContentLocale): Promise<StaffTaxonomyDto> {
  const rows = (await repo.localizedTopLocations(tx, locale)).sort(bySiblingOrder(locale));
  const groups = await repo.localizedLocationGroups(tx, locale);
  const countries = rows.filter((r) => r.parentId === null);
  const regions = new Map<string, Located[]>();
  for (const r of rows) if (r.parentId !== null) regions.set(r.parentId, [...(regions.get(r.parentId) ?? []), r]);
  const collator = new Intl.Collator(locale);
  const catalog = await loadCatalog(tx, locale);
  return {
    ...catalog,
    locations: countries.map((c) => ({ ...staffFlat(c), children: (regions.get(c.id) ?? []).map(staffFlat) })),
    locationGroups: [...groups].sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1)),
  };
}

/** Every direct child of one location, uncached, for the staff editor (one statement). */
export async function loadStaffChildren(tx: Tx, parentId: string, locale: ContentLocale) {
  return (await repo.localizedChildren(tx, parentId, locale)).sort(bySiblingOrder(locale)).map(staffFlat);
}

/** The whole localized taxonomy, for other modules. ≤ 3 statements cold, none warm. */
export async function getTaxonomy(ctx: Ctx): Promise<TaxonomyDto> {
  assertCan(ctx, 'taxonomy.read');
  const locale = ctxLocale(ctx);
  // Sequential: both loaders share the request's transaction (one connection).
  const locations = await locationsOf(locale, txReader(ctx.tx));
  const catalog = await catalogOf(locale, txReader(ctx.tx));
  return { ...locations.body, ...catalog.body };
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

/** Most bytes of one children page before gzip: gzip never grows JSON, so a page stays under 150 KB gzip. */
export const CHILDREN_PAGE_BYTES = 120_000;
/** And at most this many children per page. */
export const CHILDREN_PAGE_MAX = 1_000;

/** The top body, with the ETag of the tree it was cut from (the address of that tree's children pages). */
interface Top extends Serialized {
  tree: string;
}

/** Per cached tree object: an id index and each parent's pages, built on first use (cache misses only). */
interface Cuts {
  index: Map<string, Node>;
  pages: Map<string, string[][]>;
}
const cutsOf = new WeakMap<object, Cuts>();

function cuts(body: TaxonomyLocationsDto): Cuts {
  let c = cutsOf.get(body);
  if (!c) {
    const index = new Map<string, Node>();
    const walk = (n: Node) => {
      index.set(n.id, n);
      for (const child of n.children ?? []) walk(child);
    };
    for (const country of body.locations as Node[]) walk(country);
    c = { index, pages: new Map() };
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

export type TreeNode = Node;

/** Splits children into pages of serialized items, each ≤ `CHILDREN_PAGE_BYTES` and ≤ `CHILDREN_PAGE_MAX` items. */
export function childrenPages(children: readonly Node[]): string[][] {
  const pages: string[][] = [[]];
  let bytes = 0;
  for (const child of children) {
    const item = JSON.stringify(flat(child));
    const size = Buffer.byteLength(item) + 1;
    let page = pages[pages.length - 1] as string[];
    if (page.length > 0 && (bytes + size > CHILDREN_PAGE_BYTES || page.length >= CHILDREN_PAGE_MAX)) {
      page = [];
      pages.push(page);
      bytes = 0;
    }
    page.push(item);
    bytes += size;
  }
  return pages;
}

/** One children page as the response body (`WebsiteLocationChildrenDto`), from items serialized once. */
export function childrenPageJson(locale: string, parentId: string, items: readonly string[], next: string | null) {
  const head = `{"locale":${JSON.stringify(locale)},"parentId":${JSON.stringify(parentId)},"children":[`;
  return `${head}${items.join(',')}],"nextCursor":${JSON.stringify(next)}}`;
}

const top = (locale: ContentLocale) =>
  fresh(taxonomyCacheKey('webtop', locale), async (): Promise<Top> => {
    const tree = await currentLocations(locale);
    const body = tree.body;
    const doc = serialize({
      locale,
      locations: (body.locations as Node[]).map((country) => ({
        ...flat(country),
        children: (country.children ?? []).map(flat),
      })),
      locationGroups: body.locationGroups,
    } satisfies WebsiteLocationsDto);
    return { ...doc, tree: tree.etag };
  });

/** `GET /v2/taxonomy/locations`: countries with their regions, and the location groups. */
export async function getWebsiteLocations(lang?: string): Promise<Serialized> {
  const { etag, json } = await top(websiteLocale(lang));
  return { etag, json };
}

/** `?cursor=` of a children page: the page number the previous page named. */
function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[1-9]\d{0,3}$/.test(cursor)) throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
  return Number(cursor);
}

/**
 * `GET /v2/taxonomy/locations/:id/children`: one page of a location's direct children (S3-F2: ≤ 150 KB gzip for
 * any parent), `nextCursor` names the next. Unknown id → 404, unknown page → 422. Warm: two cache reads, no query.
 */
export async function getWebsiteLocationChildren(id: string, lang?: string, cursor?: string): Promise<Serialized> {
  const locale = websiteLocale(lang);
  const page = pageNumber(cursor);
  const { tree } = await top(locale);
  try {
    return await cache.get(
      taxonomyCacheKey('webchildren', locale, `${tree.replaceAll('"', '')}.${id}.${page}`),
      // Redis only: pages are up to 120 KB and many; one GET is cheap, and they would crowd the shared LRU.
      { ttlSeconds: CHILDREN_TTL_SECONDS },
      async () => {
        // Cut from the tree the key names: this process's copy if it is that tree, else the current one.
        let current = await locationsOf(locale);
        if (current.etag !== tree) current = await currentLocations(locale);
        const doc = cutPage(current.body, locale, id, page);
        // The tree moved on since `top` was read: answer from the newer tree, but store nothing under the old address.
        if (current.etag !== tree) throw new Uncached(doc);
        return doc;
      },
    );
  } catch (err) {
    if (err instanceof Uncached) return err.doc;
    throw err;
  }
}

/** Children pages live for 10 minutes: every tree version has its own key space (S3-F2). */
const CHILDREN_TTL_SECONDS = 600;

class Uncached extends Error {
  constructor(readonly doc: Serialized) {
    super('uncached children page');
  }
}

function cutPage(body: TaxonomyLocationsDto, locale: ContentLocale, id: string, page: number): Serialized {
  const c = cuts(body);
  const node = c.index.get(id);
  if (!node) throw new AppError('LOCATION_NOT_FOUND');
  let pages = c.pages.get(id);
  if (!pages) {
    pages = childrenPages(node.children ?? []);
    c.pages.set(id, pages);
  }
  const items = pages[page];
  if (!items) throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
  const json = childrenPageJson(locale, id, items, page + 1 < pages.length ? String(page + 1) : null);
  return { etag: etagFor(json), json };
}

/** `GET /v2/taxonomy/catalog`: property types and features. */
export async function getWebsiteCatalog(lang?: string): Promise<Serialized> {
  const locale = websiteLocale(lang);
  return fresh(taxonomyCacheKey('webcatalog', locale), async () => serialize((await currentCatalog(locale)).body));
}
