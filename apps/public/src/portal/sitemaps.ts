import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { weakCompareEtag } from '@inmolink/platform/http';
import { publicConfig } from '@/server/env';
import { portalSettings } from './data';

/**
 * The portal's sitemaps and robots.txt (S15-02). The sitemaps are files the worker writes to object storage
 * (`websiteApi.generatePortalSitemaps`); these answers only stream them: no database statement, a strong ETag (304 on
 * a match), CDN-cacheable for an hour. Stored gzip goes out as it is (`Content-Encoding: gzip`), or unzipped for a
 * client that does not accept gzip.
 */

/** Edge and browser lifetime of a sitemap answer (seconds); the files change every few hours. */
const SITEMAP_TTL = 3_600;
const SITEMAP_CACHE = `public, max-age=${SITEMAP_TTL}, s-maxage=${SITEMAP_TTL}, stale-while-revalidate=86400, stale-if-error=86400`;

export async function sitemapResponse(request: Request, name: string): Promise<Response> {
  await publicConfig();
  let file: websiteApi.PortalSitemapFile | null;
  try {
    file = await websiteApi.portalSitemapFile(name);
  } catch {
    // Storage not configured or unreachable: crawlers retry later.
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' } });
  }
  if (!file) return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });
  const gzip = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
  // One ETag per representation: the gzip bytes and the unzipped XML differ (S15-02 review).
  const etag = gzip ? `"${file.sha256}-gz"` : `"${file.sha256}"`;
  const headers = new Headers({
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': SITEMAP_CACHE,
    ETag: etag,
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
  });
  // If-None-Match: a list, weak or strong (RFC 9110 weak comparison).
  if (weakCompareEtag(request.headers.get('if-none-match') ?? undefined, etag)) {
    return new Response(null, { status: 304, headers });
  }
  const stored = await file.open();
  // Replaced by a newer run between the manifest and the read: the client asks again.
  if (!stored) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (gzip) headers.set('Content-Encoding', 'gzip');
  const body = gzip ? stored : stored.pipe(createGunzip());
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: 200, headers });
}

/** `robots.txt`: everything but the form posts, the iFrame embeds and private selection links; the sitemap index. */
export async function robotsResponse(): Promise<Response> {
  const { origin } = await portalSettings();
  const body = [
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /embed/',
    'Disallow: /s/',
    '',
    `Sitemap: ${origin}/${websiteApi.PORTAL_SITEMAP_INDEX}`,
    '',
  ].join('\n');
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
}
