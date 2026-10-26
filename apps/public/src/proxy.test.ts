import { UI_LOCALES } from '@inmolink/i18n';
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { EMBED_GATE_HEADER } from './embed/csp';
import proxy, { config, createProxy, type EmbedGate, type PortalGate } from './proxy';

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

describe('portal search pages (S15-01)', () => {
  const allow: PortalGate = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));

  it('[S15-01] junk, defaults and other orders 301 to the one canonical spelling; the canonical URL is served', async () => {
    const run = createProxy(ok(), allow);
    const cases: [string, string][] = [
      ['/en/properties?utm_source=x&price_min=100000', '/en/properties?price_min=100000'],
      ['/en/properties/spain?page=1&sort=latest', '/en/properties/spain'],
      ['/es/zone/costa?type=villa&type=apartment&type=villa', '/es/zone/costa?type=apartment&type=villa'],
      ['/en/properties?price_min=&price_max=200000', '/en/properties?price_max=200000'],
      ['/en/properties?page=2&price_min=100000', '/en/properties?price_min=100000&page=2'],
      ['/en/properties?bedrooms_min=lots', '/en/properties'],
    ];
    for (const [from, to] of cases) {
      const res = await run(request(from));
      expect(res.status, from).toBe(301);
      expect(res.headers.get('location'), from).toBe(`http://portal.test${to}`);
      expect(res.headers.get('set-cookie'), from).toBeNull();
    }
    for (const path of ['/en/properties', '/en/properties?price_min=100000&page=2', '/es/zone/costa?type=villa']) {
      const res = await run(request(path));
      expect(getRedirectUrl(res), path).toBeNull();
      expect(res.status, path).toBe(200);
    }
    // Listing pages carry no search: their query string is left alone.
    expect(getRedirectUrl(await run(request('/en/property/villa-in-x-ab12cd34?utm=1')))).toBeNull();
  });

  it('[S15-01] a client past the page limit gets a 429; a limits outage never refuses a page', async () => {
    const limited: PortalGate = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 12 }));
    const res = await createProxy(ok(), limited)(request('/en/properties', { 'x-forwarded-for': '9.9.9.9' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(limited).toHaveBeenCalledWith('9.9.9.9');
    const broken: PortalGate = vi.fn(async () => {
      throw new Error('redis down');
    });
    expect((await createProxy(ok(), broken)(request('/en/properties/spain'))).status).toBe(200);
    // Listing pages (ISR, CDN-cached) and other routes are not counted.
    const counted: PortalGate = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    await createProxy(ok(), counted)(request('/en/property/villa-in-x-ab12cd34'));
    expect(counted).not.toHaveBeenCalled();
  });

  it('[S15-01] no Set-Cookie on cached portal pages or on the locale redirect (no locale cookie)', async () => {
    const run = createProxy(ok(), allow);
    for (const path of ['/en/properties', '/es/property/villa-ab12cd34', '/en']) {
      const res = await run(request(path, { 'accept-language': 'es' }));
      expect(res.headers.get('set-cookie'), path).toBeNull();
    }
    const unprefixed = await run(request('/properties', { 'accept-language': 'es-ES' }));
    expect(getRedirectUrl(unprefixed)).toBe('http://portal.test/es/properties');
    expect(unprefixed.headers.get('set-cookie')).toBeNull();
  });
});
