/**
 * Name lookups over the cached taxonomy (S12-08, AI search for websites): a place, property type or feature name →
 * its ids, accent- and case-insensitive (`aliasKey`), in memory. Built once per tree / catalog version (ETag: a tag
 * bump brings a new one, so a staff edit shows up with the next copy); warm lookups run no query.
 */
import type { TaxonomyCatalogDto, TaxonomyLocationsDto } from '@inmolink/contracts';
import { type ContentLocale, DEFAULT_CONTENT_LOCALE, isContentLocale } from '@inmolink/i18n';
import { aliasKey } from './service';
import { websiteTaxonomyObjects } from './tree';

export interface SearchVocabulary {
  /** Locations named so — the shallowest matches (a city before its same-named area); else a group's members. */
  locations(name: string): readonly string[];
  /** Property types named so: a type, or every type of a group of that name / key. */
  types(term: string): readonly string[];
  /** Features named so (by key, slug or name). */
  features(term: string): readonly string[];
}

interface Indexes {
  locations: Map<string, { ids: string[]; depth: number }>;
  groups: Map<string, string[]>;
  types: Map<string, string[]>;
  features: Map<string, string[]>;
}

type TreeNode = { id: string; name: string; slug: string; children?: TreeNode[] };

const add = (map: Map<string, string[]>, text: string, ids: readonly string[]) => {
  const k = aliasKey(text);
  if (k === '') return;
  const list = map.get(k);
  if (!list) map.set(k, [...ids]);
  else for (const id of ids) if (!list.includes(id)) list.push(id);
};

/**
 * Built indexes per locale with the ETag of the body they were built from (S12-08 review): the in-process copies of
 * the tree are re-read every 60 s as new objects, so an identity key would rebuild a Spain-sized index each minute.
 * One entry per locale and kind: a new ETag replaces it.
 */
const built = new Map<string, { etag: string; out: unknown }>();

function memo<T>(locale: ContentLocale, kind: string, etag: string, build: () => T): T {
  const key = `${locale}:${kind}`;
  const hit = built.get(key);
  if (hit && hit.etag === etag) return hit.out as T;
  const out = build();
  built.set(key, { etag, out });
  return out;
}

function indexLocations(body: TaxonomyLocationsDto): Pick<Indexes, 'locations' | 'groups'> {
  const locations = new Map<string, { ids: string[]; depth: number }>();
  const put = (text: string, id: string, depth: number) => {
    const k = aliasKey(text);
    if (k === '') return;
    const at = locations.get(k);
    if (!at || depth < at.depth) locations.set(k, { ids: [id], depth });
    else if (depth === at.depth && !at.ids.includes(id)) at.ids.push(id);
  };
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const n of nodes) {
      put(n.name, n.id, depth);
      put(n.slug, n.id, depth);
      if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(body.locations as unknown as TreeNode[], 0);
  const groups = new Map<string, string[]>();
  for (const g of body.locationGroups) {
    if (g.locationIds.length === 0) continue;
    add(groups, g.name, g.locationIds);
    add(groups, g.slug, g.locationIds);
  }
  return { locations, groups };
}

function indexCatalog(body: TaxonomyCatalogDto): Pick<Indexes, 'types' | 'features'> {
  const types = new Map<string, string[]>();
  const features = new Map<string, string[]>();
  for (const group of body.propertyTypes) {
    const ids = group.types.map((t) => t.id);
    for (const t of group.types) for (const text of [t.key, t.slug, t.name]) add(types, text, [t.id]);
    // A group ("houses") stands for its types; a type of the same name wins (added first).
    for (const text of [group.key, group.slug, group.name]) if (!types.has(aliasKey(text))) add(types, text, ids);
  }
  for (const group of body.features) {
    for (const f of group.features) for (const text of [f.key, f.slug, f.name]) add(features, text, [f.id]);
  }
  return { types, features };
}

/** This process's last indexes per locale: served while a reload (a taxonomy tag bump) runs, like `fresh` in tree.ts. */
const previous = new Map<ContentLocale, Indexes>();

/** Tests: forget the previous copies. */
export function dropSearchVocabularyCopies(): void {
  previous.clear();
  built.clear();
}

function indexesFor(locale: ContentLocale): Promise<Indexes> {
  const next = websiteTaxonomyObjects(locale).then(({ locations, catalog }) => {
    const out = {
      ...memo(locale, 'locations', locations.etag, () => indexLocations(locations.body)),
      ...memo(locale, 'catalog', catalog.etag, () => indexCatalog(catalog.body)),
    };
    previous.set(locale, out);
    return out;
  });
  const old = previous.get(locale);
  if (!old) return next;
  // Not ready by the next macrotask (a Redis round trip or a reload from the database): the previous copy answers,
  // the reload lands for the next request — a tag bump never adds the reload's statements to a search request.
  next.catch(() => undefined);
  return Promise.race([next, new Promise<Indexes>((resolve) => setImmediate(() => resolve(old)))]);
}

/**
 * The vocabulary for website text in `lang` (falls back to the default content locale), with the default locale's
 * names too (place names are mostly written in their local form whatever the visitor's language).
 */
export async function searchVocabulary(lang: string): Promise<SearchVocabulary> {
  const primary: ContentLocale = isContentLocale(lang) ? lang : DEFAULT_CONTENT_LOCALE;
  const locales: ContentLocale[] = primary === DEFAULT_CONTENT_LOCALE ? [primary] : [primary, DEFAULT_CONTENT_LOCALE];
  const parts: Indexes[] = [];
  for (const locale of locales) parts.push(await indexesFor(locale));
  const lookup = (pick: (i: Indexes) => Map<string, string[]>) => (term: string) => {
    const k = aliasKey(term);
    for (const p of parts) {
      const hit = pick(p).get(k);
      if (hit) return hit;
    }
    return [];
  };
  return {
    locations(name) {
      const k = aliasKey(name);
      for (const p of parts) {
        const hit = p.locations.get(k)?.ids ?? p.groups.get(k);
        if (hit) return hit;
      }
      return [];
    },
    types: lookup((i) => i.types),
    features: lookup((i) => i.features),
  };
}
