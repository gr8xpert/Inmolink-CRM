import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import nextConfig, { ENQUIRY_NOTICE_CACHE, PORTAL_ISR_PAGE_CACHE, PORTAL_PAGE_CACHE } from '../next.config';
import { type CodeGate, createProxy, type EmbedGate, type PortalGate } from './proxy';

vi.mock('./server/legacy-redirects', () => ({ legacyRedirect: async () => null }));
vi.mock('./server/env', () => ({ publicConfig: async () => ({}), portalOriginOf: () => 'https://inmolink.test' }));

/** The `Cache-Control` the next.config `headers()` rules give a URL. */
async function configCache(path: string): Promise<string | null> {
  const res = await unstable_getResponseFromNextConfig({ url: `https://inmolink.test${path}`, nextConfig });
  return res.headers.get('cache-control');
}

/**
 * The header a visitor gets when both set one: Next (16.4, `resolve-routes`) applies the `headers()` rules first, then
 * copies the proxy's response headers over them (a later `setHeader` of the same name wins).
 */
async function effectiveCache(path: string, proxyRes: Response): Promise<string | null> {
  return proxyRes.headers.get('cache-control') ?? (await configCache(path));
}

describe('portal CDN headers (S15 review)', () => {
  it('[S15-01] review: listing and development pages get a minute at the edge, never Next’s ~1-year stale window', async () => {
    expect(PORTAL_ISR_PAGE_CACHE).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=30, stale-if-error=600');
    for (const path of ['/en/property/villa-in-x-ab12cd34', '/es/development/residencial-x-ab12cd34']) {
      expect(await configCache(path), path).toBe(PORTAL_ISR_PAGE_CACHE);
    }
    // Search, location, zone, agency and home pages: 45 s, stale-if-error 10 minutes (not a day).
    expect(PORTAL_PAGE_CACHE).toContain('stale-if-error=600');
    for (const path of ['/en', '/en/properties', '/en/properties/spain', '/en/zone/costa-blanca']) {
      expect(await configCache(path), path).toBe(PORTAL_PAGE_CACHE);
    }
    // An enquiry notice is the visitor's own, on every portal page shape.
    for (const path of ['/en/property/villa-in-x-ab12cd34?enquiry=sent', '/en/properties?enquiry=sent']) {
      expect(await configCache(path), path).toBe(ENQUIRY_NOTICE_CACHE);
    }
  });

  it('[S15-01] review: the proxy’s 429 is no-store even on paths a headers() rule caches publicly', async () => {
    const embed: EmbedGate = async () => ({ kind: 'not-found' });
    const limited: PortalGate = async () => ({ allowed: false, retryAfterSeconds: 5 });
    const madeUp: CodeGate = async (_slug, beforeProbe) => ((await beforeProbe()) ? 'unknown' : 'limited');
    const run = createProxy(embed, limited, async () => null, undefined, madeUp);
    for (const path of [
      '/en/properties',
      '/en/property/x-yyyyyyyy',
      '/en/agency/01900000-0000-7000-8000-0000000000a1/x',
    ]) {
      const res = await run(new NextRequest(`https://inmolink.test${path}`));
      expect(res.status, path).toBe(429);
      expect(await configCache(path), path).toMatch(/^public/);
      expect(await effectiveCache(path, res), path).toBe('no-store');
    }
  });
});
