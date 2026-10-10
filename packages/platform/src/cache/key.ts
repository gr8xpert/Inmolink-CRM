declare const cacheKeyBrand: unique symbol;

/** A key built by `cacheKey()`. The cache accepts nothing else, so every key states its tenant scope. */
export type CacheKey = string & { readonly [cacheKeyBrand]: true };

export interface CacheKeyParts {
  /** Value schema version — bump it when the cached shape changes. */
  v: number;
  module: string;
  entity: string;
  /**
   * Whose data this is. Tenant data must name the agency: the loader ran under that agency's RLS,
   * so sharing the result with another tenant would bypass it. `global` only for data that is the
   * same for everyone (taxonomy, platform config).
   */
  scope: 'global' | { agencyId: string };
  id?: string | number;
  locale?: string;
  /** Client Mode output (white-labelled) never shares a key with the agent view. */
  view?: 'agent' | 'client';
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const KEY_RE =
  /^v\d+:[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:(g|a\.[0-9a-f-]{36})(:i\.[^\s:]+)?(:l\.[A-Za-z-]+)?(:(agent|client))?$/;
export const MAX_KEY_LENGTH = 512;

/**
 * `v<schema>:<module>:<entity>:<g|a.<agencyId>>[:i.<id>][:l.<locale>][:<view>]` (PATTERNS §15).
 * Segments are tagged and the id is percent-encoded, so no user value can shift into another segment.
 */
export function cacheKey(parts: CacheKeyParts): CacheKey {
  if (!Number.isInteger(parts.v) || parts.v < 1) throw new TypeError('cache key: v must be a positive integer');
  if (!NAME_RE.test(parts.module)) throw new TypeError('cache key: invalid module');
  if (!NAME_RE.test(parts.entity)) throw new TypeError('cache key: invalid entity');
  let key = `v${parts.v}:${parts.module}:${parts.entity}:`;
  if (parts.scope === 'global') key += 'g';
  else if (UUID_RE.test(parts.scope.agencyId)) key += `a.${parts.scope.agencyId}`;
  else throw new TypeError('cache key: agencyId must be a lowercase UUID');
  if (parts.id !== undefined) {
    const id = String(parts.id);
    if (id === '') throw new TypeError('cache key: empty id');
    key += `:i.${encodeURIComponent(id)}`;
  }
  if (parts.locale !== undefined) {
    if (!LOCALE_RE.test(parts.locale)) throw new TypeError('cache key: invalid locale');
    key += `:l.${parts.locale}`;
  }
  if (parts.view !== undefined) key += `:${parts.view}`;
  if (key.length > MAX_KEY_LENGTH) throw new TypeError(`cache key longer than ${MAX_KEY_LENGTH} chars`);
  return key as CacheKey;
}

/** Runtime check for keys that bypassed the type system (casts, JS callers). */
export function assertCacheKey(key: string): asserts key is CacheKey {
  if (key.length > MAX_KEY_LENGTH || !KEY_RE.test(key)) {
    throw new TypeError('cache key must be built with cacheKey()');
  }
}
