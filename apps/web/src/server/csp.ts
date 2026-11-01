/**
 * S16-03 (PLAN §12): the dashboard's Content-Security-Policy. Pure: the proxy builds it per request with a fresh nonce
 * and the hosts from the web config (`cspSourcesOf`).
 *
 * - Scripts run only with the nonce (Next stamps it on its own scripts, read from this header on the request) or when a
 *   nonced script loads them (`'strict-dynamic'`: the Turnstile loader, dynamic imports); nothing inline, no `eval`
 *   outside development. Every page renders per request (the root layout awaits `connection()`), so no nonce is cached.
 * - Styles allow `'unsafe-inline'` — accepted (security-R1.md §3): React `style` props and MapLibre's runtime styles;
 *   a style injection cannot run script under this policy.
 * - Images, uploads and sockets only to the hosts the dashboard uses: the media CDN (`MEDIA_CDN_URL`), object storage
 *   (`S3_ENDPOINT`: signed GETs and the browser's presigned PUTs), the realtime service (`REALTIME_PUBLIC_URL`, its
 *   ws/wss form too), the map style host (`MAP_STYLE_URL`) plus any tile / glyph hosts its style names
 *   (`MAP_TILE_ORIGINS`), and Turnstile. The dashboard API (`API_URL`) is called server-side only, so it is not listed.
 * - MapLibre's worker is a same-origin file (`/maplibre/…`); nothing may frame the dashboard.
 */

/** Cloudflare Turnstile (login, sign-up): its script, challenge frame and calls. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** The browser-reachable hosts of the dashboard, as CSP source expressions (origins). */
export interface CspSources {
  /** img-src and media-src: media CDN, storage, map hosts. */
  images: readonly string[];
  /** connect-src: storage (presigned PUT), realtime (http(s) + ws(s)), map hosts, Turnstile. */
  connect: readonly string[];
}

/** The config keys the policy reads (a subset of `WebConfig`). */
export interface CspConfig {
  MEDIA_CDN_URL?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  REALTIME_PUBLIC_URL: string;
  MAP_STYLE_URL: string;
  MAP_TILE_ORIGINS?: string | undefined;
}

/** `scheme://host[:port]` of an http(s) URL, or null (anything else never becomes a source). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The socket form of an http(s) origin (`https://rt.example` → `wss://rt.example`). */
const socketOf = (origin: string) => origin.replace(/^http/, 'ws');

const unique = (items: readonly (string | null)[]) => [...new Set(items.filter((s): s is string => s !== null))];

export function cspSourcesOf(config: CspConfig): CspSources {
  const media = config.MEDIA_CDN_URL ? originOf(config.MEDIA_CDN_URL) : null;
  const storage = config.S3_ENDPOINT ? originOf(config.S3_ENDPOINT) : null;
  const realtime = originOf(config.REALTIME_PUBLIC_URL);
  const map = [
    originOf(config.MAP_STYLE_URL),
    ...(config.MAP_TILE_ORIGINS ?? '')
      .split(',')
      .filter((s) => s.trim() !== '')
      .map(originOf),
  ];
  return {
    images: unique([media, storage, ...map]),
    connect: unique([storage, realtime, realtime ? socketOf(realtime) : null, ...map, TURNSTILE_ORIGIN]),
  };
}

export function dashboardCsp(nonce: string, dev: boolean, sources: CspSources): string {
  const list = (items: readonly string[]) => (items.length > 0 ? ` ${items.join(' ')}` : '');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${list(sources.images)}`,
    // Video previews of picked files (`blob:`) and uploaded videos / documents on the media CDN or storage.
    `media-src 'self' blob: data:${list(sources.images)}`,
    "font-src 'self' data:",
    // Development: Next's HMR socket on the dev server's own port.
    `connect-src 'self'${list(sources.connect)}${dev ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    "worker-src 'self' blob:",
    `frame-src ${TURNSTILE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** 16 random bytes, base64: a CSP nonce. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
