/**
 * Legacy URL redirects (S14-05, PLAN §14 step 8, M14): a URL that existed on inmolink.es or in a plugin-built page
 * answers 301 to its v2 equivalent, never 404.
 *
 * - `normalizeLegacyUrl` turns a requested URL into the lookup key (lower-case path, no trailing slash, only the query
 *   keys that identify a page, sorted). Pure; the builder and the resolver share it, so they cannot disagree.
 * - `buildRedirectRows` makes rows from the legacy URL list and `legacy_id_maps` (listing / development / location
 *   ids → v2 ids); the v2 path comes from a caller-supplied `targetPath` (the portal's URL helpers, S15), the legacy
 *   ids are not guessed here. An entry that yields no row is returned as `unmapped` (reported, never dropped).
 * - `resolveLegacyRedirect` is the request-path lookup (portal and plugin shim): one indexed probe, answers kept in
 *   process (hits 10 min, misses 1 min, bounded LRUs so made-up URLs cannot evict real ones), hit counts buffered in
 *   memory and written by `flushRedirectHits` (job `migration.flushRedirectHits`): no write per request.
 */
import { withPublicRead, withSystem } from '@inmolink/db';
import { LocalLru } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import * as repo from './repo';

export type RedirectSource = 'portal' | 'plugin';
export type { RedirectRow } from './repo';

/** Query keys that identify a page on a legacy URL; every other key (utm_*, session ids) is dropped. */
export const REDIRECT_QUERY_KEYS = [
  'development_id',
  'id',
  'listing_id',
  'p',
  'page_id',
  'property_id',
  'ref',
] as const;
export const REDIRECT_PATH_MAX = 2_000;

export interface NormalizedLegacyUrl {
  /** The first path segment when it is a two-letter language code, else ''. */
  locale: string;
  /** `/path` plus `?k=v&…` for the identifying keys. */
  pathKey: string;
}

/** The lookup key of a legacy URL (absolute, or a path with optional query); null for what cannot be a legacy URL. */
export function normalizeLegacyUrl(raw: string): NormalizedLegacyUrl | null {
  if (raw.length === 0 || raw.length > REDIRECT_PATH_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw, 'https://legacy.invalid');
  } catch {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  path = path.toLowerCase().replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (!path.startsWith('/') || path.includes('\0')) return null;
  const query = REDIRECT_QUERY_KEYS.flatMap((k) => {
    const v = url.searchParams.get(k);
    return v === null || v === '' ? [] : [`${k}=${v.toLowerCase()}`];
  });
  const seg = path.split('/')[1] ?? '';
  return {
    locale: /^[a-z]{2}$/.test(seg) ? seg : '',
    pathKey: query.length ? `${path}?${query.join('&')}` : path,
  };
}

export interface LegacyUrlEntry {
  source: RedirectSource;
  /** The legacy URL as crawled or exported. */
  url: string;
  entity: 'listing' | 'development' | 'location' | 'page';
  /** The legacy id the URL names (listings, developments, locations); absent for a static page. */
  legacyId?: string;
  /** Static pages: the v2 path directly. */
  staticTarget?: string;
}

export interface BuildRedirectsInput {
  entries: readonly LegacyUrlEntry[];
  /** `legacy_id_maps` answers: `<entity>:<legacy id>` → v2 id. */
  maps: ReadonlyMap<string, string>;
  /** The portal's URL helper for a v2 entity in a locale ('' = the default locale). */
  targetPath: (entity: 'listing' | 'development' | 'location', id: string, locale: string) => string | null;
}

export interface BuildRedirectsResult {
  rows: repo.RedirectRow[];
  /** Entries that produced no row, with the reason: nothing is silently dropped. */
  unmapped: { url: string; reason: 'invalid-url' | 'no-map' | 'no-target' }[];
}

export function buildRedirectRows(input: BuildRedirectsInput): BuildRedirectsResult {
  const rows = new Map<string, repo.RedirectRow>();
  const unmapped: BuildRedirectsResult['unmapped'] = [];
  for (const e of input.entries) {
    const key = normalizeLegacyUrl(e.url);
    if (!key) {
      unmapped.push({ url: e.url, reason: 'invalid-url' });
      continue;
    }
    let target: string | null;
    let targetId: string | null = null;
    if (e.entity === 'page') {
      target = e.staticTarget ?? null;
    } else {
      targetId = e.legacyId ? (input.maps.get(`${e.entity}:${e.legacyId}`) ?? null) : null;
      if (!targetId) {
        unmapped.push({ url: e.url, reason: 'no-map' });
        continue;
      }
      target = input.targetPath(e.entity, targetId, key.locale);
    }
    if (!target?.startsWith('/') || target.startsWith('//')) {
      unmapped.push({ url: e.url, reason: 'no-target' });
      continue;
    }
    rows.set(`${e.source}|${key.locale}|${key.pathKey}`, {
      source: e.source,
      locale: key.locale,
      pathKey: key.pathKey,
      targetPath: target,
      entity: e.entity,
      targetId,
      status: 301,
    });
  }
  return { rows: [...rows.values()], unmapped };
}

/** Writes redirect rows (migration scripts / admin), idempotent. */
export async function saveRedirects(rows: readonly repo.RedirectRow[], reason = 'S14-05 save legacy redirects') {
  return withSystem(reason, (tx) => repo.upsertRedirects(tx, rows));
}

export interface ResolvedRedirect {
  status: 301 | 308;
  targetPath: string;
}

const found = new LocalLru<string>(50_000);
const missing = new LocalLru<true>(5_000);
const FOUND_TTL_MS = 10 * 60_000;
const MISSING_TTL_MS = 60_000;
const pendingHits = new Map<string, { source: string; locale: string; pathKey: string; hits: number }>();
/** Distinct buffered URLs at most; beyond it hits of new URLs are dropped (counters are statistics, not truth). */
export const REDIRECT_HIT_BUFFER_MAX = 20_000;

/** Tests: forget cached answers and buffered hits. */
export function resetRedirectCache(): void {
  found.clear();
  missing.clear();
  pendingHits.clear();
}

/**
 * The redirect for a requested legacy URL, or null (the caller then renders its normal 404). One probe on a cache
 * miss; counts the hit in memory.
 */
export async function resolveLegacyRedirect(source: RedirectSource, rawUrl: string): Promise<ResolvedRedirect | null> {
  const key = normalizeLegacyUrl(rawUrl);
  if (!key) return null;
  const ck = `${source}|${key.locale}|${key.pathKey}`;
  let hit = found.get(ck);
  if (hit === undefined) {
    if (missing.get(ck)) return null;
    const row = await withPublicRead((tx) => repo.redirectByKey(tx, source, key.locale, key.pathKey));
    if (!row) {
      missing.set(ck, true, MISSING_TTL_MS);
      return null;
    }
    hit = JSON.stringify({ status: row.status === 308 ? 308 : 301, targetPath: row.targetPath });
    found.set(ck, hit, FOUND_TTL_MS);
  }
  const counter = pendingHits.get(ck);
  if (counter) counter.hits += 1;
  else if (pendingHits.size < REDIRECT_HIT_BUFFER_MAX) {
    pendingHits.set(ck, { source, locale: key.locale, pathKey: key.pathKey, hits: 1 });
  }
  return JSON.parse(hit) as ResolvedRedirect;
}

/** Writes the buffered hit counts (one statement per 1,000 URLs) and clears the buffer. Returns URLs flushed. */
export async function flushRedirectHits(): Promise<number> {
  if (pendingHits.size === 0) return 0;
  const batch = [...pendingHits.values()];
  pendingHits.clear();
  try {
    await withSystem('S14-05 flush legacy redirect hit counters', (tx) => repo.addRedirectHits(tx, batch, clock.now()));
  } catch (err) {
    // Put the counts back for the next flush.
    for (const b of batch) {
      const k = `${b.source}|${b.locale}|${b.pathKey}`;
      const cur = pendingHits.get(k);
      if (cur) cur.hits += b.hits;
      else pendingHits.set(k, b);
    }
    throw err;
  }
  return batch.length;
}
