import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/** Locale routing (S0-11): adds the locale prefix and passes the route locale to the app. */
export default createMiddleware(routing);

export const config = {
  // Everything except route handlers (`/api` incl. Auth.js, `/session`, `/healthz`), Next internals
  // and files with an extension.
  matcher: '/((?!(?:api|session|healthz)(?:/|$)|_next|_vercel|.*\\..*).*)',
};
