import { NextRequest, type NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { type CspSources, cspSourcesOf, dashboardCsp, newNonce } from './server/csp';

const intl = createMiddleware(routing);

/** The CSP hosts, read once from the web config (env only, nothing connected). */
export type SourcesLoader = () => Promise<CspSources>;

let loaded: Promise<CspSources> | undefined;
const fromConfig: SourcesLoader = () => {
  loaded ??= import('./server/env').then((env) => cspSourcesOf(env.loadWebConfig()));
  return loaded;
};

/**
 * Locale routing (S0-11): adds the locale prefix and passes the route locale to the app. S16-03: every page answer
 * carries the nonce CSP (`server/csp.ts`); the request carries it too (`Content-Security-Policy`, `x-nonce`), which is
 * where Next reads the nonce from while rendering.
 */
export function createProxy(sources: SourcesLoader = fromConfig) {
  return async function proxy(request: NextRequest): Promise<NextResponse> {
    const nonce = newNonce();
    const csp = dashboardCsp(nonce, process.env.NODE_ENV === 'development', await sources());
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('content-security-policy', csp);
    const res = intl(new NextRequest(request, { headers }));
    res.headers.set('Content-Security-Policy', csp);
    return res;
  };
}

export default createProxy();

export const config = {
  // Everything except route handlers (`/api` incl. Auth.js, `/session`, `/healthz`), Next internals and static files
  // by extension (S16-03: only these; any other dotted path runs the proxy and gets the page CSP, even as a 404).
  matcher:
    '/((?!(?:api|session|healthz)(?:/|$)|_next|_vercel|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|css|m?js|map|woff2?|txt|xml|json|webmanifest)$).*)',
};
