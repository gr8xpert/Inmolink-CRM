import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/**
 * Locale routing (S0-11): every portal page has a locale prefix (`/es/…`), the base for per-locale
 * slugs, hreflang and sitemaps (PLAN §3 #14).
 */
export default createMiddleware(routing);

export const config = {
  // Everything except route handlers (`/api`, `/healthz`), Next internals and files with an extension
  // (so slugs never contain a dot).
  matcher: '/((?!(?:api|healthz)(?:/|$)|_next|_vercel|.*\\..*).*)',
};
