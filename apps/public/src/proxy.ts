import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { DENY_FRAMING, EMBED_GATE_HEADER, embedPath } from './embed/csp';
import { routing } from './i18n/routing';
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

export function createProxy(gate: EmbedGate, portalGate: PortalGate = defaultPortalGate) {
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
      if (canonical !== null) {
        const to = request.nextUrl.clone();
        to.search = canonical;
        const moved = NextResponse.redirect(to, 301);
        for (const [k, v] of Object.entries(DENY_FRAMING)) moved.headers.set(k, v);
        moved.headers.set('Cache-Control', 'public, max-age=3600');
        return moved;
      }
    }
    const res = intl(request);
    for (const [k, v] of Object.entries(DENY_FRAMING)) res.headers.set(k, v);
    return res;
  };
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
    // Every embed path: none may render without the gate.
    '/embed/:path*',
    '/embed',
  ],
};
