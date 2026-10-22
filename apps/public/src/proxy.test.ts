import { UI_LOCALES } from '@inmolink/i18n';
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { EMBED_GATE_HEADER } from './embed/csp';
import proxy, { config, createProxy, type EmbedGate } from './proxy';

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://portal.test${path}`, { headers });

describe('public locale routing', () => {
  it('[S0-11] an unprefixed path redirects to the Accept-Language locale', async () => {
    const es = await proxy(request('/search?verified=1', { 'accept-language': 'es-ES,es;q=0.9' }));
    expect(getRedirectUrl(es)).toBe('http://portal.test/es/search?verified=1');
    const fallback = await proxy(request('/search', { 'accept-language': 'ja' }));
    expect(getRedirectUrl(fallback)).toBe('http://portal.test/en/search');
  });

  it('[S0-11] a prefixed path is served in its locale, whatever the browser prefers', async () => {
    for (const locale of UI_LOCALES) {
      const res = await proxy(request(`/${locale}/search`, { 'accept-language': 'xx' }));
      expect(getRedirectUrl(res)).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it('[S0-11] route handlers and assets bypass locale routing', () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    expect(runs('/search')).toBe(true);
    expect(runs('/es/property/x')).toBe(true);
    expect(runs('/apartments')).toBe(true);
    expect(runs('/healthzone')).toBe(true);
    for (const url of ['/healthz', '/api/revalidate', '/_next/static/x.js', '/favicon.ico']) {
      expect(runs(url)).toBe(false);
    }
  });
});

const SITE = '01900000-0000-7000-8000-0000000000aa';
const MARKER = 'gate-marker-of-the-site';
const ok = (): EmbedGate => vi.fn(async () => ({ kind: 'ok' as const, marker: MARKER }));
/** The request headers the proxy hands the route (`x-middleware-request-*`). */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

describe('iFrame embed gate (S7-F8)', () => {
  it('[S7-F8] a checked embed request reaches its route with the gate marker; a client-sent marker is replaced', async () => {
    const gate = ok();
    const res = await createProxy(gate)(
      request(`/embed/${SITE}/en/listing/CH-1234`, { 'x-forwarded-for': '1.2.3.4', [EMBED_GATE_HEADER]: 'forged' }),
    );
    expect(gate).toHaveBeenCalledWith(SITE, '1.2.3.4');
    expect(res.status).toBe(200);
    expect(forwarded(res, EMBED_GATE_HEADER)).toBe(MARKER);
    // The route sets the page's CSP and caching; the proxy adds no framing header of its own.
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('[S7-F8] refused sites (another mode, suspended agency, deleted, unknown) and bad paths are a 404 nothing may frame', async () => {
    const refused: EmbedGate = vi.fn(async () => ({ kind: 'not-found' as const }));
    for (const path of [`/embed/${SITE}/en`, '/embed/not-a-site/en', '/embed', `/embed/${SITE}`]) {
      const res = await createProxy(refused)(request(path));
      expect(res.status, path).toBe(404);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
    }
    // Malformed paths never reach the site lookup.
    expect(refused).toHaveBeenCalledTimes(1);
    const limited: EmbedGate = vi.fn(async () => ({ kind: 'limited' as const, retryAfterSeconds: 30 }));
    const res = await createProxy(limited)(request(`/embed/${SITE}/en`));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('[S7-F8] other spellings of an embed path (encoded, upper case, double slashes) are refused, never routed around the gate', async () => {
    const gate = ok();
    for (const path of [
      `/%65mbed/${SITE}/en`,
      `/%65MBED/${SITE}/en`,
      `/EMBED/${SITE}/en`,
      `/Embed/${SITE}/en/listing/X`,
      `//embed/${SITE}/en`,
      `/embed//${SITE}/en`,
      `/embed/${SITE.toUpperCase()}/en`,
      `/embed/${SITE}/EN`,
      '/%2Fembed/x',
    ]) {
      const res = await createProxy(gate)(request(path));
      expect(res.status, path).toBe(404);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(forwarded(res, EMBED_GATE_HEADER), path).toBeNull();
    }
    expect(gate).not.toHaveBeenCalled();
    // Each of them runs the proxy at all (the general matcher covers them).
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of [`/%65mbed/${SITE}/en`, `/EMBED/${SITE}/en`, `//embed/${SITE}/en`])
      expect(runs(url), url).toBe(true);
  });

  it('[S7-F8] every other route still sends X-Frame-Options: DENY; every embed path (dots included) runs the gate', async () => {
    const gate = ok();
    for (const path of ['/en/search', '/es', '/en/property/x']) {
      const res = await createProxy(gate)(request(path));
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
    }
    expect(gate).not.toHaveBeenCalled();
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of [`/embed/${SITE}/en`, `/embed/${SITE}/en/listing/A.B-1`, '/embed', `/embed/${SITE}/en/x.js`]) {
      expect(runs(url), url).toBe(true);
    }
  });
});
