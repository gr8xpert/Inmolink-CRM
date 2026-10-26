import { PortalQuery, portalQueryHasFilters, portalQueryString } from '@inmolink/contracts';

/**
 * The portal's query strings (S15-01): one spelling per search. Pure and dependency-light — the proxy imports it to
 * send any other spelling to the canonical URL (301), so junk parameters never make a new CDN cache key.
 */

// S15-F7: the one spelling lives in contracts (core's page metadata reads it too).
export { portalQueryHasFilters as hasFilters, portalQueryString as queryString };

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
  const canonical = portalQueryString(PortalQuery.parse(paramsRecord(new URLSearchParams(search))));
  return canonical === (search === '?' ? '' : search) ? null : canonical;
}
