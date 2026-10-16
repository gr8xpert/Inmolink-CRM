import { ListingFilter, ListingSort } from '@inmolink/contracts';
import { columnsOf, type ListState } from './list-query';

/**
 * The list state of a `/listings` URL (S3-07), parsed with the contracts' schemas — on the server only (S4-F2: zod
 * stays out of the listings client chunk). Invalid values are dropped one by one, never an error page.
 */
const FILTER_KEYS = Object.keys(ListingFilter.shape) as (keyof ListingFilter)[];
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseListState(params: Params): ListState {
  const filter: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = one(params[key]);
    if (value === undefined || value === '') continue;
    const parsed = ListingFilter.shape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined) filter[key] = parsed.data;
  }
  const sort = ListingSort.safeParse(one(params.sort));
  const cursor = one(params.cursor);
  return {
    filter: filter as ListingFilter,
    sort: sort.success ? sort.data : 'newest',
    cursor: cursor && CURSOR.test(cursor) ? cursor : undefined,
    columns: columnsOf(one(params.cols)),
  };
}
