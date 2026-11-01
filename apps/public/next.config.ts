import { fileURLToPath } from 'node:url';
import { PAGE_BASE_CSP } from '@inmolink/platform/web-security';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import {
  ENQUIRY_NOTICE_CACHE,
  PORTAL_ISR_PAGE_CACHE,
  PORTAL_MEMBER_PAGE_CACHE,
  PORTAL_PAGE_CACHE,
} from './src/portal/cache-control';

/**
 * Every path but the iFrame embeds (S7-F8) may never be framed. The proxy sets the same on the pages it runs for; this
 * also covers route handlers and anything it skips. The embeds' own `frame-ancestors` comes from the proxy.
 * S16-F8: a selection page (`/s/<token>`, S12-04) sends its own, stricter headers (`selections/handlers.ts`: DENY,
 * `frame-ancestors 'none'` and a `script-src`) — a rule here would replace its CSP with this one, which has none.
 */
export const NOT_EMBED_SOURCE = '/:path((?!embed/|embed$|s/[^/]+/?$).*)';
export const FRAME_DENY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  // S17-F1: platform's plain-ESM `web-security` (unbuilt, so `next typegen` can load it before the packages build).
  { key: 'Content-Security-Policy', value: PAGE_BASE_CSP },
];

/**
 * S16-03 (PLAN §12): on every path (pages, embeds, route handlers, assets). No `Referrer-Policy` here: browsers default
 * to `strict-origin-when-cross-origin`, and the selection pages send their own `no-referrer`.
 */
export const PUBLIC_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

// S15-01 / S15 review: the portal pages' CDN headers (shared with the proxy).
export {
  ENQUIRY_NOTICE_CACHE,
  PORTAL_ISR_PAGE_CACHE,
  PORTAL_MEMBER_PAGE_CACHE,
  PORTAL_PAGE_CACHE,
} from './src/portal/cache-control';

const LOCALE = ':locale([a-z]{2})';
export const PORTAL_CACHED_SOURCES = [
  `/${LOCALE}`,
  `/${LOCALE}/properties`,
  `/${LOCALE}/properties/:path+`,
  `/${LOCALE}/zone/:zone`,
  // S15-03: agency profile pages (their listings page like a search).
  `/${LOCALE}/agency/:id/:name`,
];
/** S15-F10: members' published profiles — like the pages above, but never served stale on an origin error. */
export const PORTAL_MEMBER_SOURCES = [`/${LOCALE}/agent/:id/:name`];
/**
 * S15 review: the ISR pages (listing, development). Their `Cache-Control` comes from this rule, not from Next's
 * `revalidate`-based header (which only applies when none is set): the CDN keeps them a minute, never ~a year stale.
 */
export const PORTAL_ISR_SOURCES = [`/${LOCALE}/property/:slug`, `/${LOCALE}/development/:slug`];

/**
 * S15-F7: the ISR page cache (listing and development pages, ADR 0019 (A)): bounded per instance and invalidated on
 * every instance by shared tag times (`cache-handler.mjs` → platform `PageCacheHandler`). Next's default handler would
 * also write every rendered page to the server's disk — unbounded for ~2M listings × locales.
 */
export const PAGE_CACHE_HANDLER = fileURLToPath(new URL('./cache-handler.mjs', import.meta.url));
// S15-F11: no `cacheMaxMemorySize` here (Next freezes it into the build): the handler reads its cap at run time from
// `PAGE_CACHE_MAX_BYTES` (env, validated by platform `pageCacheEnv`, default 256 MB).

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  cacheHandler: PAGE_CACHE_HANDLER,
  // Server-only code loaded from node_modules at runtime, not bundled (S7-F8: the embeds read through core).
  serverExternalPackages: ['@inmolink/core', '@inmolink/db', '@inmolink/platform', 'pg', 'ioredis', 'bullmq'],
  async headers() {
    return [
      // S16-03: every answer, embeds included.
      { source: '/:path*', headers: PUBLIC_SECURITY_HEADERS },
      { source: NOT_EMBED_SOURCE, headers: FRAME_DENY_HEADERS },
      ...PORTAL_CACHED_SOURCES.map((source) => ({
        source,
        headers: [{ key: 'Cache-Control', value: PORTAL_PAGE_CACHE }],
      })),
      ...PORTAL_ISR_SOURCES.map((source) => ({
        source,
        headers: [{ key: 'Cache-Control', value: PORTAL_ISR_PAGE_CACHE }],
      })),
      ...PORTAL_MEMBER_SOURCES.map((source) => ({
        source,
        headers: [{ key: 'Cache-Control', value: PORTAL_MEMBER_PAGE_CACHE }],
      })),
      // S15-03 review: a page carrying an enquiry form's answer (`?enquiry=`) is the visitor's own: never cached
      // publicly (the proxy sets the same; this rule comes last, so it wins over the one above).
      ...[...PORTAL_CACHED_SOURCES, ...PORTAL_ISR_SOURCES, ...PORTAL_MEMBER_SOURCES].map((source) => ({
        source,
        has: [{ type: 'query' as const, key: 'enquiry' }],
        headers: [{ key: 'Cache-Control', value: ENQUIRY_NOTICE_CACHE }],
      })),
    ];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
