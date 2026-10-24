import type { Option, OptionGroup } from './taxonomy';

/** How many matching locations the picker renders at once (a select with thousands of options is thousands of nodes). */
export const LOCATION_RENDER_LIMIT = 50;
/** Feature groups rendered before "show more", and features per open group. */
export const GROUPS_PAGE = 30;
export const FEATURES_PAGE = 60;
/** Features listed across all groups while a search is typed. */
export const FEATURE_SEARCH_LIMIT = 100;

/** Lower case without accents: "Málaga" is found by "malaga". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** True when every word of the query occurs in the (folded) text. */
export function matchesQuery(foldedText: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.every((w) => foldedText.includes(w));
}

export interface Searchable<T> {
  item: T;
  folded: string;
}

export function searchable<T extends { label: string }>(items: readonly T[]): Searchable<T>[] {
  return items.map((item) => ({ item, folded: fold(item.label) }));
}

/** The locations to render: the selected one first if it is not among the matches, then at most `limit` matches. */
export function locationMatches(
  all: readonly Searchable<Option>[],
  query: string,
  selectedId: string,
  limit = LOCATION_RENDER_LIMIT,
): { shown: Option[]; total: number } {
  const hits: Option[] = [];
  let total = 0;
  const q = query.trim();
  for (const s of all) {
    if (q && !matchesQuery(s.folded, q)) continue;
    total++;
    if (hits.length < limit) hits.push(s.item);
  }
  if (selectedId && !hits.some((o) => o.id === selectedId)) {
    const sel = all.find((s) => s.item.id === selectedId);
    if (sel) hits.unshift(sel.item);
  }
  return { shown: hits, total };
}

/** Features matching a typed search, grouped, at most `limit` in all. */
export function featureMatches(
  groups: readonly { group: OptionGroup; options: Searchable<Option>[] }[],
  query: string,
  limit = FEATURE_SEARCH_LIMIT,
): { groups: OptionGroup[]; total: number } {
  const out: OptionGroup[] = [];
  let total = 0;
  let shown = 0;
  for (const g of groups) {
    const options: Option[] = [];
    for (const o of g.options) {
      if (!matchesQuery(o.folded, query)) continue;
      total++;
      if (shown < limit) {
        options.push(o.item);
        shown++;
      }
    }
    if (options.length > 0) out.push({ label: g.group.label, options });
  }
  return { groups: out, total };
}
