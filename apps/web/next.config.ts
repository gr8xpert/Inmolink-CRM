import type { NextConfig } from 'next';

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
  // Email-link pages carry a one-time token in the URL: never leak it in a Referer header.
  async headers() {
    return ['/verify-email', '/reset-password'].map((source) => ({
      source,
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    }));
  },
};

export default nextConfig;
