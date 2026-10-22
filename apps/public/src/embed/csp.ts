/**
 * Response security headers of the public pages (S7-F8). Pure: the proxy and the embed routes apply them.
 *
 * - Embed pages (`/embed/<site>/…`): a static CSP — the pages carry no inline script (no framework, no flight data), so
 *   `script-src 'self'` + Turnstile's challenge host, no nonce, no `'unsafe-inline'` for scripts; `frame-ancestors`
 *   lists the site's own domains only (`https://<host>`, checked in core — `embedFrameAncestors`); no
 *   `X-Frame-Options` (its DENY would win over frame-ancestors in older browsers and break the embed). Images from the
 *   media CDN.
 * - Every other page: `X-Frame-Options: DENY` and `frame-ancestors 'none'` — nothing may frame them.
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Set by the proxy on embed requests it checked (a keyed MAC of the site id), read by the embed routes: an embed
 * renders only behind the proxy's check. Any copy a client sends is removed first.
 */
export const EMBED_GATE_HEADER = 'x-inmolink-embed-gate';

export const DENY_FRAMING: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

/** The origin of a URL (`https://media.example`), or null when it is not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Only `https://<host>` sources pass (defence in depth: the list comes from core already checked). */
const SOURCE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function embedCsp(input: { frameAncestors: readonly string[]; mediaOrigin: string | null }): string {
  const ancestors = input.frameAncestors.filter((s) => SOURCE.test(s));
  const media = input.mediaOrigin ? ` ${input.mediaOrigin}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    // The inline stylesheet and the brand colours (CSS custom properties of hex values only, checked in core).
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${media}`,
    "font-src 'self'",
    `connect-src 'self' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(' ') : "'none'"}`,
  ].join('; ');
}

/** `/embed/<site id>/<lang>[/…]`: the site id and language, or null for any other path. */
const EMBED_PATH = /^\/embed\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z]{2})(?:\/|$)/;

/** A path as a router might read it: percent-decoded, lower case, repeated slashes collapsed. */
function normalized(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: judged as written.
  }
  return p.toLowerCase().replace(/\/{2,}/g, '/');
}

/**
 * The embed a path names: its site id and language; `'invalid'` for any other path that is, or could be read as, an
 * embed path (`/embed/x`, `/%65mbed/…`, `/EMBED/…`, `//embed/…`) — refused, so no spelling reaches an embed route
 * around the check; null for every other path.
 */
export function embedPath(pathname: string): { siteId: string; lang: string } | 'invalid' | null {
  const n = normalized(pathname);
  if (n !== '/embed' && !n.startsWith('/embed/')) return null;
  const m = EMBED_PATH.exec(pathname);
  return m ? { siteId: m[1] as string, lang: m[2] as string } : 'invalid';
}
