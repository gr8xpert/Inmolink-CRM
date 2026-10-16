import type { ListingColumn, ListingFilter, ListingSort, ListingViewQuery } from '@inmolink/contracts';
import { DEFAULT_LISTING_COLUMNS, LISTING_COLUMNS, LISTING_FILTER_KEYS } from '@inmolink/contracts/values';

/**
 * The listing list's state in the URL (S3-07): the API's filter names and values (prices in cents), `sort`,
 * `cursor` and `cols` (shown columns, comma-separated). A saved view stores the same query and columns, so a
 * view is a link. Invalid values are dropped one by one, never an error page (`parseListState`, server side in
 * `./list-state`). This module stays zod-free: the toolbar (a client component) imports it (S4-F2).
 */
export interface ListState {
  filter: ListingFilter;
  sort: ListingSort;
  cursor: string | undefined;
  columns: ListingColumn[];
}

const FILTER_KEYS: readonly (keyof ListingFilter)[] = LISTING_FILTER_KEYS;

export function columnsOf(raw: string | undefined): ListingColumn[] {
  const picked = (raw ?? '')
    .split(',')
    .filter((c): c is ListingColumn => (LISTING_COLUMNS as readonly string[]).includes(c));
  const unique = [...new Set(picked)];
  if (unique.length === 0) return [...DEFAULT_LISTING_COLUMNS];
  // The reference opens the listing: always shown, first.
  return ['ref', ...unique.filter((c) => c !== 'ref')];
}

/** The query string of a list state (no cursor unless given); default sort and columns are left out. */
export function listSearch(
  state: { filter: ListingFilter; sort?: ListingSort; columns?: ListingColumn[] },
  cursor?: string,
) {
  const qs = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = state.filter[key];
    if (value === undefined || value === '' || value === false) continue;
    qs.set(key, String(value));
  }
  if (state.sort && state.sort !== 'newest') qs.set('sort', state.sort);
  const cols = state.columns?.join(',');
  if (cols && cols !== DEFAULT_LISTING_COLUMNS.join(',')) qs.set('cols', cols);
  if (cursor) qs.set('cursor', cursor);
  return qs.toString();
}

/** `/listings?…` for a saved view. */
export function viewHref(view: { query: ListingViewQuery; columns: ListingColumn[] }): string {
  const { sort, ...filter } = view.query;
  const search = listSearch({ filter, ...(sort ? { sort } : {}), columns: view.columns });
  return search ? `/listings?${search}` : '/listings';
}

/** Whole euros, optionally grouped by thousands (`350000`, `350.000`, `350,000`, `350 000`). */
const WHOLE_EUROS = /^(\d+|\d{1,3}([.,\s]\d{3})+)$/;

/** Euros typed in a filter field → cents for the API; empty, decimal or invalid → undefined (filters are whole euros). */
export function centsOf(euros: string): number | undefined {
  const text = euros.trim();
  if (!WHOLE_EUROS.test(text)) return undefined;
  const value = Number(text.replace(/[\s.,]/g, ''));
  return Number.isSafeInteger(value * 100) ? value * 100 : undefined;
}
