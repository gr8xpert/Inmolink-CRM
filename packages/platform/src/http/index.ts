import { createHash } from 'node:crypto';

export { clientIpFromForwarded, type TrustProxy } from './client-ip';

/**
 * Cache-Control builders and ETag helpers. feed-api responses are public and shared by
 * the CDN; dashboard responses are private; anything with per-user secrets is no-store.
 */
export interface FeedCacheOptions {
  /** CDN TTL in seconds. */
  sMaxAge: number;
  /** Browser TTL in seconds (default 0: browsers revalidate, the CDN absorbs it). */
  maxAge?: number;
  /** Serve stale while revalidating, seconds (default = sMaxAge). */
  staleWhileRevalidate?: number;
  /** Serve stale when origin errors, seconds (default 86 400). */
  staleIfError?: number;
}

function seconds(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

export const cacheControl = {
  feed(options: FeedCacheOptions): string {
    const sMaxAge = seconds('sMaxAge', options.sMaxAge);
    return [
      'public',
      `max-age=${seconds('maxAge', options.maxAge ?? 0)}`,
      `s-maxage=${sMaxAge}`,
      `stale-while-revalidate=${seconds('staleWhileRevalidate', options.staleWhileRevalidate ?? sMaxAge)}`,
      `stale-if-error=${seconds('staleIfError', options.staleIfError ?? 86_400)}`,
    ].join(', ');
  },
  /** Per-user data that the browser may reuse briefly, never shared caches. */
  private(maxAge = 0): string {
    return `private, max-age=${seconds('maxAge', maxAge)}, must-revalidate`;
  },
  /** Immutable, content-hashed assets. */
  immutable(maxAge = 31_536_000): string {
    return `public, max-age=${seconds('maxAge', maxAge)}, immutable`;
  },
  noStore(): string {
    return 'no-store';
  },
};

/** Strong ETag from the body bytes (or a version string such as `listingId:version:locale`). */
export function etagFor(content: string | Uint8Array): string {
  return `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;
}

export function weakEtag(etag: string): string {
  return etag.startsWith('W/') ? etag : `W/${etag}`;
}

function opaque(tag: string): string {
  const t = tag.trim();
  return t.startsWith('W/') ? t.slice(2) : t;
}

/**
 * Weak comparison (RFC 9110 §8.8.3.2) for `If-None-Match`: true when any listed tag
 * matches, or the header is `*`. Use it to answer 304.
 */
export function weakCompareEtag(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch;
  if (header.trim() === '*') return true;
  const target = opaque(etag);
  return header.split(',').some((candidate) => opaque(candidate) === target);
}
