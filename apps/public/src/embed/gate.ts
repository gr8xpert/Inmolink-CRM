import { hmacSha256, safeEqual } from '@inmolink/platform/crypto';

/**
 * The embed gate marker (S7-F8): a keyed MAC (`HMAC_KEY`) of the site id and the current minute, set by the proxy on
 * the request it checked and required by the embed routes. Bound to time (security review), so a marker seen once is
 * worthless a minute or two later; the current and the previous minute are accepted (a request that crossed the
 * minute boundary between proxy and route).
 */
const MINUTE_MS = 60_000;

export const minuteOf = (nowMs: number) => Math.floor(nowMs / MINUTE_MS);

export function gateMarker(key: string | Uint8Array, siteId: string, minute: number): string {
  return hmacSha256(key, 'public.embed-gate', `${siteId}|${minute}`);
}

export function gateMarkerValid(
  key: string | Uint8Array,
  siteId: string,
  marker: string | null,
  nowMs: number,
): boolean {
  if (marker === null) return false;
  const now = minuteOf(nowMs);
  // Both compared (constant time each), whatever the first says.
  const current = safeEqual(marker, gateMarker(key, siteId, now));
  const previous = safeEqual(marker, gateMarker(key, siteId, now - 1));
  return current || previous;
}
