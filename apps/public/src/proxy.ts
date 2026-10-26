import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { DENY_FRAMING, EMBED_GATE_HEADER, embedPath } from './embed/csp';
import { routing } from './i18n/routing';
import { localRedirectTarget } from './portal/legacy';
import { canonicalSearch } from './portal/query';
import type { EmbedGateResult } from './server/embed';

/**
 * Locale routing (S0-11): every portal page has a locale prefix (`/es/…`), the base for per-locale slugs, hreflang and
 * sitemaps (PLAN §3 #14) — and may not be framed (`X-Frame-Options: DENY`, S7-F8).
 *
 * iFrame embeds (S7-F8): `/embed/<site>/<lang>/…` skip locale routing (the site's languages, not the portal's). Before
 * an embed route runs, the gate counts the client's page limit and checks the site (core `embedSiteScope`: IFRAME mode,
 * verified agency, domains); a passed request carries the gate marker (`EMBED_GATE_HEADER`, a keyed MAC of the site)
 * that the route requires — any copy the client sent is dropped first. The route sets the page's CSP
 * (`frame-ancestors` = the site's domains) and caching. Refused sites and other spellings of an embed path
 * (`/%65mbed/…`, `/EMBED/…`, `//embed/…`) are a plain 404 that nothing may frame.
 */
export type EmbedGate = (siteId: string, forwardedFor: string | null) => Promise<EmbedGateResult>;

/**
 * S15-01: the portal's search, location and zone pages render per request — per client address, a generous page limit
 * (`PORTAL_PAGE_LIMIT_PER_MINUTE`); fails open (a limits outage never takes the portal down).
 */
export type PortalGate = (forwardedFor: string | null) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

/**
 * S15-02: the legacy redirect for a requested path and query (`legacy_url_redirects`, S14-05) and its status, or null.
 * `beforeProbe` is asked before a database probe (a cache miss): the client's page limit — false skips the probe.
 */
export type LegacyGate = (
  pathWithQuery: string,
  beforeProbe: () => Promise<boolean>,
) => Promise<{ targetPath: string; status: 301 | 308 } | null>;

/**
 * The portal's own page shapes (`/en`, `/en/properties…`, `/en/property/…`, `/en/development/…`, `/en/zone/…`,
 * `/en/agency/…`): their pages ask the legacy redirects themselves, and only on a 404. Every other path may be an old
 * inmolink.es URL and is looked up here first, before locale routing — a true 301 (a page can only answer 308).
 */
const PORTAL_PAGE_PATH = /^\/[a-z]{2}(?:\/(?:properties|property|development|zone|agency)(?:\/|$)|\/?$)/;

/** Old pages with an extension the proxy sees (the matcher's second entry). */
const LEGACY_FILE_PATH = /\.(?:php|html?|aspx?)$/i;

/** Portal paths whose query string is a search (`/en/properties…`, `/es/zone/…`). */
const PORTAL_SEARCH_PATH = /^\/[a-z]{2}\/(?:properties|zone)(?:\/|$)/;

const intl = createMiddleware(routing);

function refuse(status: 404 | 429, retryAfterSeconds?: number): NextResponse {
  const res = new NextResponse(null, { status });
  for (const [k, v] of Object.entries(DENY_FRAMING)) res.headers.set(k, v);
  res.headers.set('Cache-Control', 'no-store');
  if (retryAfterSeconds !== undefined) res.headers.set('Retry-After', String(Math.max(1, retryAfterSeconds)));
  return res;
}

async function portalAllowed(portalGate: PortalGate, forwardedFor: string | null) {
  try {
    return await portalGate(forwardedFor);
  } catch {
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

type LegacyAnswer =
  | { kind: 'redirect'; targetPath: string; status: 301 | 308 }
  | { kind: 'limited'; retryAfterSeconds: number }
  | null;

/**
 * The legacy redirect for this request. A cache miss costs a database probe, so it counts against the client's page
 * limit first (S15-02 review): made-up URLs cannot drive probes or churn the resolver's miss cache. The resolver's
 * normalizer keeps only the query keys that identify a legacy page (`REDIRECT_QUERY_KEYS`): tracking parameters make
 * no new keys.
 */
async function legacyTarget(
  legacyGate: LegacyGate,
  portalGate: PortalGate,
  request: NextRequest,
): Promise<LegacyAnswer> {
  const { pathname, search } = request.nextUrl;
  // The bare root without a query is the locale negotiation's (`/` → `/en`), not a legacy page.
  if (PORTAL_PAGE_PATH.test(pathname) || (pathname === '/' && search === '')) return null;
  let limited: { retryAfterSeconds: number } | null = null;
  const beforeProbe = async () => {
    const limit = await portalAllowed(portalGate, request.headers.get('x-forwarded-for'));
    if (!limit.allowed) limited = { retryAfterSeconds: limit.retryAfterSeconds };
    return limit.allowed;
  };
  try {
    const found = await legacyGate(`${pathname}${search}`, beforeProbe);
    if (limited) return { kind: 'limited', ...(limited as { retryAfterSeconds: number }) };
    const targetPath = localRedirectTarget(found?.targetPath);
    return found && targetPath ? { kind: 'redirect', targetPath, status: found.status === 308 ? 308 : 301 } : null;
  } catch {
    // Fails open: a lookup outage never takes a page down (the page renders, or 404s).
    return null;
  }
}

/** S15-02: the portal's configured origin (`PORTAL_URL`, else `PUBLIC_URL`): redirects are built on it. */
export type PortalOrigin = () => Promise<string>;

/**
 * A permanent redirect to a path on this site, on the configured origin — never one built from the request's `Host`
 * header, which the client controls (S15-02 review). (Next refuses a relative `Location` from the proxy.)
 */
function movedTo(origin: string, path: string, status: 301 | 308 = 301): NextResponse {
  const moved = new NextResponse(null, { status, headers: { Location: new URL(path, origin).href } });
  for (const [k, v] of Object.entries(DENY_FRAMING)) moved.headers.set(k, v);
  moved.headers.set('Cache-Control', 'public, max-age=3600');
  return moved;
}

export function createProxy(
  gate: EmbedGate,
  portalGate: PortalGate = defaultPortalGate,
  legacyGate: LegacyGate = defaultLegacyGate,
  portalOrigin: PortalOrigin = defaultPortalOrigin,
) {
  return async function proxy(request: NextRequest): Promise<NextResponse> {
    const embed = embedPath(request.nextUrl.pathname);
    if (embed === 'invalid') return refuse(404);
    if (embed) {
      const result = await gate(embed.siteId, request.headers.get('x-forwarded-for'));
      if (result.kind === 'not-found') return refuse(404);
      if (result.kind === 'limited') return refuse(429, result.retryAfterSeconds);
      // `set` replaces any copy the client sent (only a MAC made with HMAC_KEY passes the route's check anyway).
      const headers = new Headers(request.headers);
      headers.set(EMBED_GATE_HEADER, result.marker);
      return NextResponse.next({ request: { headers } });
    }
    if (PORTAL_SEARCH_PATH.test(request.nextUrl.pathname)) {
      const limit = await portalAllowed(portalGate, request.headers.get('x-forwarded-for'));
      if (!limit.allowed) return refuse(429, limit.retryAfterSeconds);
      // One spelling per search (S15-01 review): any other order, junk or default parameter moves to the canonical URL,
      // so made-up parameters never make new CDN cache keys or page renders.
      const canonical = canonicalSearch(request.nextUrl.search);
      if (canonical !== null) return movedTo(await portalOrigin(), `${request.nextUrl.pathname}${canonical}`);
    }
    const legacy = await legacyTarget(legacyGate, portalGate, request);
    if (legacy?.kind === 'limited') return refuse(429, legacy.retryAfterSeconds);
    if (legacy?.kind === 'redirect') return movedTo(await portalOrigin(), legacy.targetPath, legacy.status);
    // An old page with an extension that names nothing now: a plain 404 (portal slugs never contain a dot).
    if (LEGACY_FILE_PATH.test(request.nextUrl.pathname)) return refuse(404);
    const res = intl(request);
    for (const [k, v] of Object.entries(DENY_FRAMING)) res.headers.set(k, v);
    return res;
  };
}

async function defaultLegacyGate(pathWithQuery: string, beforeProbe: () => Promise<boolean>) {
  return (await import('./server/legacy-redirects')).legacyRedirect(pathWithQuery, beforeProbe);
}

async function defaultPortalOrigin() {
  const env = await import('./server/env');
  return env.portalOriginOf(await env.publicConfig());
}

async function defaultPortalGate(forwardedFor: string | null) {
  return (await import('./server/portal-limits')).portalPageGate(forwardedFor);
}

export default createProxy(async (siteId, forwardedFor) =>
  (await import('./server/embed')).embedGate(siteId, forwardedFor),
);

export const config = {
  matcher: [
    // Everything except route handlers (`/api`, `/healthz`, S12-04: a selection's `/s/<token>` — no locale prefix, its
    // own headers), Next internals, files with an extension (so slugs never contain a dot) and the embeds (matched
    // below, dots included).
    '/((?!(?:api|healthz|embed|s)(?:/|$)|_next|_vercel|.*\\..*).*)',
    // S15-02: old inmolink.es pages with an extension (`/index.php?page_id=…`, `/contacto.html`): legacy redirects.
    '/((?!(?:api|healthz|embed|s|sitemaps|_next|_vercel)(?:/|$)).*\\.(?:php|html?|aspx?))',
    // Every embed path: none may render without the gate.
    '/embed/:path*',
    '/embed',
  ],
};
