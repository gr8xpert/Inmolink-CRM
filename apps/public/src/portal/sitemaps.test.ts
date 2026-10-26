import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ portalSitemapFile: vi.fn(), PORTAL_SITEMAP_INDEX: 'sitemap.xml' }));
vi.mock('@inmolink/core/modules/website-api', () => core);
vi.mock('@/server/env', () => ({ publicConfig: async () => ({}) }));
vi.mock('./data', () => ({ portalSettings: async () => ({ origin: 'https://inmolink.test' }) }));

const { robotsResponse, sitemapResponse } = await import('./sitemaps');

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex/>';
const stored = () => ({ sha256: 'abc', open: async () => Readable.from([gzipSync(XML)]) });
const get = (headers: Record<string, string> = {}) => new Request('https://inmolink.test/sitemap.xml', { headers });

beforeEach(() => {
  core.portalSitemapFile.mockReset();
});

describe('portal sitemaps and robots.txt (S15-02)', () => {
  it('[S15-02] a stored sitemap is streamed as gzip with a strong ETag, cacheable; 304 on a match', async () => {
    core.portalSitemapFile.mockResolvedValue(stored());
    const res = await sitemapResponse(get({ 'accept-encoding': 'gzip, br' }), 'sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('etag')).toBe('"abc-gz"');
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=3600, s-maxage=3600/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(gzipSync(XML));
    // One ETag per encoding; If-None-Match may be a list, weak or not.
    const gz = { 'accept-encoding': 'gzip' };
    expect((await sitemapResponse(get({ ...gz, 'if-none-match': '"x", W/"abc-gz"' }), 'sitemap.xml')).status).toBe(304);
    expect((await sitemapResponse(get({ ...gz, 'if-none-match': '"abc"' }), 'sitemap.xml')).status).toBe(200);
    expect((await sitemapResponse(get({ 'if-none-match': '"abc"' }), 'sitemap.xml')).status).toBe(304);
    expect((await sitemapResponse(get(), 'sitemap.xml')).headers.get('etag')).toBe('"abc"');
  });

  it('[S15-02] a client without gzip gets the XML itself; an unknown or ungenerated file is a 404', async () => {
    core.portalSitemapFile.mockResolvedValue(stored());
    const plain = await sitemapResponse(get(), 'en-listings-1.xml');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(XML);
    core.portalSitemapFile.mockResolvedValue(null);
    expect((await sitemapResponse(get(), 'en-listings-9.xml')).status).toBe(404);
    core.portalSitemapFile.mockRejectedValue(new Error('storage is not configured'));
    expect((await sitemapResponse(get(), 'sitemap.xml')).status).toBe(503);
  });

  it('[S15-02] robots.txt names the sitemap index on the portal origin and keeps crawlers off posts and private pages', async () => {
    const res = await robotsResponse();
    const text = await res.text();
    expect(text).toContain('Sitemap: https://inmolink.test/sitemap.xml');
    for (const path of ['/api/', '/embed/', '/s/']) expect(text).toContain(`Disallow: ${path}`);
    expect(text).not.toMatch(/Disallow: \/\s*$/m);
  });
});
