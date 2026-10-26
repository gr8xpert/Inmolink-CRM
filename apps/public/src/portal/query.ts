import { PORTAL_QUERY_KEYS, PortalQuery } from '@inmolink/contracts';

/**
 * The portal's query strings (S15-01): one spelling per search. Pure and dependency-light — the proxy imports it to
 * send any other spelling to the canonical URL (301), so junk parameters never make a new CDN cache key.
 */

/** Whether a query narrows the results (any filter or a sort; the page alone does not). */
export function hasFilters(q: PortalQuery): boolean {
  return PORTAL_QUERY_KEYS.some((k) => {
    if (k === 'page') return false;
    const v = q[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && !(k === 'sort' && v === 'latest');
  });
}

/**
 * A query string in a stable order without defaults (`sort=latest`, `page=1`), `?`-prefixed or empty: links,
 * canonicals and pagination always spell one search the same way.
 */
export function queryString(q: PortalQuery, change: Partial<PortalQuery> = {}): string {
  const merged: PortalQuery = { ...q, ...change };
  const params = new URLSearchParams();
  for (const k of PORTAL_QUERY_KEYS) {
    const v = merged[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of [...v].sort()) params.append(k, String(x));
    else if (!(k === 'sort' && v === 'latest') && !(k === 'page' && v === 1)) params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** `URLSearchParams` as the record `PortalQuery` reads (repeated keys as arrays). */
export function paramsRecord(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length === 1 ? (all[0] as string) : all;
  }
  return out;
}

/** The canonical spelling of a search's query string (`search` as `URL.search`), or null when it already is. */
export function canonicalSearch(search: string): string | null {
  const canonical = queryString(PortalQuery.parse(paramsRecord(new URLSearchParams(search))));
  return canonical === (search === '?' ? '' : search) ? null : canonical;
}
