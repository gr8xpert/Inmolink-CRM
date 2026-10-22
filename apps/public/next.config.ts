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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only code loaded from node_modules at runtime, not bundled (S7-F8: the embeds read through core).
  serverExternalPackages: ['@inmolink/core', '@inmolink/db', '@inmolink/platform', 'pg', 'ioredis', 'bullmq'],
  async headers() {
    return [{ source: NOT_EMBED_SOURCE, headers: FRAME_DENY_HEADERS }];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
