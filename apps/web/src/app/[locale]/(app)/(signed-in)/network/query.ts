import {
  NETWORK_SEARCH_LIMIT_MAX,
  type NetworkSearchBody,
  PUBLIC_SEARCH_SORTS,
  type PublicSearchSort,
} from '@inmolink/contracts';

/**
 * Network search state in the URL (S5-05), so a search is a link: `q`, `kind`, `newBuilds`, `preferred`, `type`,
 * `location`, `min` / `max` (whole euros), `beds`, `sort`, `view` (list | map) and `cursor`. Anything malformed is
 * dropped, never sent: the API validates again.
 */
export interface NetworkState {
  q?: string;
  kind?: 'LISTING' | 'UNIT';
  newBuilds: boolean;
  preferred: boolean;
  type?: string;
  location?: string;
  min?: number;
  max?: number;
  beds?: number;
  sort: PublicSearchSort;
  view: 'list' | 'map';
  cursor?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_EUROS = 1_000_000_000;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const whole = (v: string | undefined, max: number) => {
  if (v === undefined || !/^\d{1,10}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= max ? n : undefined;
};

export function parseNetworkState(params: Record<string, string | string[] | undefined>): NetworkState {
  const q = one(params.q)?.trim().slice(0, 100);
  const kind = one(params.kind);
  const type = one(params.type);
  const location = one(params.location);
  const sort = one(params.sort);
  const cursor = one(params.cursor);
  return {
    q: q ? q : undefined,
    kind: kind === 'LISTING' || kind === 'UNIT' ? kind : undefined,
    newBuilds: one(params.newBuilds) === '1',
    preferred: one(params.preferred) === '1',
    type: type && UUID.test(type) ? type : undefined,
    location: location && UUID.test(location) ? location : undefined,
    min: whole(one(params.min), MAX_EUROS),
    max: whole(one(params.max), MAX_EUROS),
    beds: whole(one(params.beds), 50),
    sort: (PUBLIC_SEARCH_SORTS as readonly string[]).includes(sort ?? '') ? (sort as PublicSearchSort) : 'newest',
    view: one(params.view) === 'map' ? 'map' : 'list',
    cursor: cursor && CURSOR.test(cursor) ? cursor : undefined,
  };
}

/** The API body for this state: a map shows one full page of pins. */
export function networkBody(s: NetworkState): NetworkSearchBody {
  return {
    ...(s.q ? { text: s.q } : {}),
    ...(s.kind ? { kind: s.kind } : {}),
    newBuilds: s.newBuilds,
    preferredOnly: s.preferred,
    ...(s.type ? { propertyTypeIds: [s.type] } : {}),
    ...(s.location ? { locationIds: [s.location] } : {}),
    ...(s.min !== undefined ? { priceMinCents: s.min * 100 } : {}),
    ...(s.max !== undefined ? { priceMaxCents: s.max * 100 } : {}),
    ...(s.beds !== undefined ? { bedsMin: s.beds } : {}),
    sort: s.sort,
    limit: s.view === 'map' ? NETWORK_SEARCH_LIMIT_MAX : 24,
    ...(s.cursor ? { cursor: s.cursor } : {}),
  };
}

/** The query string of this state with some fields changed (`undefined` / false drops one). */
export function networkSearch(s: NetworkState, change: Partial<NetworkState> = {}): string {
  const next = { ...s, ...change };
  const qs = new URLSearchParams();
  if (next.q) qs.set('q', next.q);
  if (next.kind) qs.set('kind', next.kind);
  if (next.newBuilds) qs.set('newBuilds', '1');
  if (next.preferred) qs.set('preferred', '1');
  if (next.type) qs.set('type', next.type);
  if (next.location) qs.set('location', next.location);
  if (next.min !== undefined) qs.set('min', String(next.min));
  if (next.max !== undefined) qs.set('max', String(next.max));
  if (next.beds !== undefined) qs.set('beds', String(next.beds));
  if (next.sort !== 'newest') qs.set('sort', next.sort);
  if (next.view === 'map') qs.set('view', 'map');
  if (next.cursor) qs.set('cursor', next.cursor);
  return qs.toString();
}
