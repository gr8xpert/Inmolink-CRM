import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Every path but the iFrame embeds (S7-F8) may never be framed. The proxy sets the same on the pages it runs for; this
 * also covers route handlers and anything it skips. The embeds' own `frame-ancestors` comes from the proxy.
 */
export const NOT_EMBED_SOURCE = '/:path((?!embed/|embed$).*)';
export const FRAME_DENY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

/**
 * S15-01: the portal's search, location and home pages render per request (filters and pages ride in the query
 * string), so Next would mark them private; they hold no visitor data, so the CDN may keep them briefly and serve a
 * stale copy while it refetches. Listing pages are ISR (`revalidate`) and get Next's own `s-maxage`.
 */
export const PORTAL_PAGE_CACHE = 'public, max-age=0, s-maxage=120, stale-while-revalidate=600, stale-if-error=86400';
/** S15-03 review: a page with the enquiry form's answer (`?enquiry=`). */
export const ENQUIRY_NOTICE_CACHE = 'private, no-store';
const LOCALE = ':locale([a-z]{2})';
export const PORTAL_CACHED_SOURCES = [
  `/${LOCALE}`,
  `/${LOCALE}/properties`,
  `/${LOCALE}/properties/:path+`,
  `/${LOCALE}/zone/:zone`,
  // S15-03: agency profile pages (their listings page like a search).
  `/${LOCALE}/agency/:id/:name`,
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only code loaded from node_modules at runtime, not bundled (S7-F8: the embeds read through core).
  serverExternalPackages: ['@inmolink/core', '@inmolink/db', '@inmolink/platform', 'pg', 'ioredis', 'bullmq'],
  async headers() {
    return [
      { source: NOT_EMBED_SOURCE, headers: FRAME_DENY_HEADERS },
      ...PORTAL_CACHED_SOURCES.map((source) => ({
        source,
        headers: [{ key: 'Cache-Control', value: PORTAL_PAGE_CACHE }],
      })),
      // S15-03 review: a page carrying an enquiry form's answer (`?enquiry=`) is the visitor's own: never cached
      // publicly (the proxy sets the same; this rule comes last, so it wins over the one above).
      ...PORTAL_CACHED_SOURCES.map((source) => ({
        source,
        has: [{ type: 'query' as const, key: 'enquiry' }],
        headers: [{ key: 'Cache-Control', value: ENQUIRY_NOTICE_CACHE }],
      })),
    ];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
