import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/** S16-03 (PLAN §12): the dashboard's static security headers, on every path. */
export const DASHBOARD_SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
];
/** Route handlers (the proxy skips them): JSON and redirects only. */
export const HANDLER_SOURCE = '/:prefix(api|session|healthz)/:path*';
export const HANDLER_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only code loaded from node_modules at runtime, not bundled: native Argon2, pg, and the
  // workspace packages (core locates the repo env file relative to its own dist folder in dev).
  serverExternalPackages: [
    '@inmolink/core',
    '@inmolink/db',
    '@inmolink/platform',
    '@node-rs/argon2',
    'pg',
    'ioredis',
    'bullmq',
  ],
  async headers() {
    return [
      // S16-03: every answer (pages, route handlers, assets, errors). Pages get their nonce CSP from the proxy; route
      // handlers (`/api`, `/session`, `/healthz`) render nothing, so their CSP allows nothing (`HANDLER_CSP`).
      { source: '/:path*', headers: DASHBOARD_SECURITY_HEADERS },
      { source: HANDLER_SOURCE, headers: [{ key: 'Content-Security-Policy', value: HANDLER_CSP }] },
      // Email-link pages carry a one-time token in the URL: never leak it in a Referer header (last: it wins).
      ...['/:locale/verify-email', '/:locale/reset-password', '/:locale/accept-invite'].map((source) => ({
        source,
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      })),
    ];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
