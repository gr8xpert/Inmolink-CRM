import type {
  CatalogKind,
  CreateCatalogItemInput,
  LocationLevel,
  StaffTaxonomyDto,
  UnmatchedDto,
  UnmatchedKind,
} from '@inmolink/contracts';
import { slugify } from '../translation-editor';

/** Presentation helpers of the mapping queue (S17-F22). The API decides what a mapping does. */

/** Tab order: what refuses a listing first (a missing type or location), what only holds it last. */
export const QUEUE_KINDS: readonly UnmatchedKind[] = ['propertyType', 'location', 'feature'];
export const QUEUE_PAGE_SIZE = 50;
/** Most options one list renders; a region can have over 2,000 cities, so the filter narrows the rest. */
export const OPTION_CAP = 200;

export const parseQueueKind = (raw: unknown): UnmatchedKind =>
  QUEUE_KINDS.find((k) => k === raw) ?? (QUEUE_KINDS[0] as UnmatchedKind);

export interface PickOption {
  id: string;
  label: string;
}

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

/** Options whose label holds every word typed, ignoring accents and case; at most `cap` of them. */
export function filterOptions<O extends PickOption>(
  options: readonly O[],
  query: string,
  cap: number = OPTION_CAP,
): { shown: O[]; hidden: number } {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const hits = words.length === 0 ? options : options.filter((o) => words.every((w) => normalize(o.label).includes(w)));
  return { shown: hits.slice(0, cap), hidden: Math.max(0, hits.length - cap) };
}

export const pathLabel = (names: readonly string[]): string => names.join(' › ');

export interface CatalogGroup {
  id: string;
  name: string;
  items: { id: string; name: string }[];
}

/** The groups and items of a kind, in the shape the queue picks from. */
export function catalogGroups(tree: StaffTaxonomyDto, kind: CatalogKind): CatalogGroup[] {
  return kind === 'propertyType'
    ? tree.propertyTypes.map((g) => ({ id: g.id, name: g.name, items: g.types }))
    : tree.features.map((g) => ({ id: g.id, name: g.name, items: g.features }));
}

export const catalogOptions = (groups: readonly CatalogGroup[]): PickOption[] =>
  groups.flatMap((g) => g.items.map((i) => ({ id: i.id, label: pathLabel([g.name, i.name]) })));

export interface LocationNode {
  id: string;
  name: string;
  level: LocationLevel;
  childCount: number;
  /** The names above it, from the country down. */
  path: string[];
}

export const locationLabel = (node: Pick<LocationNode, 'name' | 'path'>): string =>
  pathLabel([...node.path, node.name]);

/** The children of a node, carrying their path; any location list of the API fits. */
export function childNodes(
  parent: Pick<LocationNode, 'name' | 'path'> | null,
  children: readonly { id: string; name: string; level: LocationLevel; childCount: number }[],
): LocationNode[] {
  const path = parent ? [...parent.path, parent.name] : [];
  return children.map(({ id, name, level, childCount }) => ({ id, name, level, childCount, path }));
}

/** The first list: every country followed by its regions (the staff tree comes with those two levels). */
export function rootLocationNodes(locations: StaffTaxonomyDto['locations']): LocationNode[] {
  return locations.flatMap((country) => {
    const [node] = childNodes(null, [country]) as [LocationNode];
    return [node, ...childNodes(node, country.children)];
  });
}

/** The name of a location in the page's language, else the default content language, else any. */
export function translatedName(
  translations: readonly { locale: string; name: string }[],
  locale: string,
  defaultLocale: string,
): string {
  const found =
    translations.find((t) => t.locale === locale) ??
    translations.find((t) => t.locale === defaultLocale) ??
    translations[0];
  return found?.name ?? '';
}

/** Longest URL slug the contract takes. */
const SLUG_MAX = 120;

/**
 * "Create new and map": the feed value becomes the item's name, its slug the API's key (S17-F13). Null when the value
 * gives no usable slug (no Latin letters or digits): such an item is created in the editor, where a slug can be typed.
 */
export function newCatalogItem(
  kind: CatalogKind,
  groupId: string,
  value: string,
  locale: string,
): CreateCatalogItemInput | null {
  const slug = slugify(value).slice(0, SLUG_MAX).replace(/-+$/, '');
  if (!slug) return null;
  return { kind, groupId, translations: [{ locale, name: value.trim(), slug }] };
}

/** A later page after the rows on screen. A value can move between pages while an import counts it: never twice. */
export function appendPage(current: readonly UnmatchedDto[], incoming: readonly UnmatchedDto[]): UnmatchedDto[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => !seen.has(r.id))];
}
