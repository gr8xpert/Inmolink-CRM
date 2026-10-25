import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { DENY_FRAMING, EMBED_GATE_HEADER, embedPath } from './embed/csp';
import { routing } from './i18n/routing';
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

const intl = createMiddleware(routing);

function refuse(status: 404 | 429, retryAfterSeconds?: number): NextResponse {
  const res = new NextResponse(null, { status });
  for (const [k, v] of Object.entries(DENY_FRAMING)) res.headers.set(k, v);
  res.headers.set('Cache-Control', 'no-store');
  if (retryAfterSeconds !== undefined) res.headers.set('Retry-After', String(Math.max(1, retryAfterSeconds)));
  return res;
}

export function createProxy(gate: EmbedGate) {
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
    const res = intl(request);
    for (const [k, v] of Object.entries(DENY_FRAMING)) res.headers.set(k, v);
    return res;
  };
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
