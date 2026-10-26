import { UI_LOCALES } from '@inmolink/i18n';
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { EMBED_GATE_HEADER } from './embed/csp';
import proxy, { type CodeGate, config, createProxy, type EmbedGate, type LegacyGate, type PortalGate } from './proxy';

// S15-02: the default legacy lookup needs the database; these checks pass their own (`createProxy`'s third gate).
vi.mock('./server/legacy-redirects', () => ({ legacyRedirect: async () => null }));
// S15 review: the default listing / development page gate needs the database; known by default here.
vi.mock('./server/portal-limits', () => ({
  portalCodeGate: async () => 'known',
  portalPageGate: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
// Redirects are built on the configured portal origin, never the request's Host (`portal.test` in these requests).
vi.mock('./server/env', () => ({
  publicConfig: async () => ({}),
  portalOriginOf: () => 'https://inmolink.test',
}));

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
      // On the configured portal origin, never the request's Host header (S15-02 review).
      expect(res.headers.get('location'), from).toBe(`https://inmolink.test${to}`);
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

  it('[S15-03] agency profile pages: one spelling of their listings’ query, the page limit counted', async () => {
    const counted: PortalGate = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const run = createProxy(ok(), counted);
    const page = '/en/agency/01900000-0000-7000-8000-0000000000a1/move-homes';
    const moved = await run(request(`${page}?utm_source=x&page=1`));
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe(`https://inmolink.test${page}`);
    expect(counted).toHaveBeenCalled();
    for (const path of [page, `${page}?page=2`]) {
      const res = await run(request(path));
      expect(getRedirectUrl(res), path).toBeNull();
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).not.toBe('private, no-store');
    }
  });

  it('[S15-03] an enquiry notice (`?enquiry=`) is kept only when known, and never cached publicly', async () => {
    const run = createProxy(ok(), allow);
    const agency = '/en/agency/01900000-0000-7000-8000-0000000000a1/move-homes';
    const listing = '/en/property/villa-in-x-ab12cd34';
    // A known notice: the page renders, privately.
    for (const path of [`${agency}?enquiry=sent`, `${agency}?page=2&enquiry=RATE_LIMITED`, `${listing}?enquiry=sent`]) {
      const res = await run(request(path));
      expect(getRedirectUrl(res), path).toBeNull();
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('private, no-store');
    }
    // Junk (unknown, repeated, made up): 301 to the page without it — never a cache key of its own.
    const cases: [string, string][] = [
      [`${agency}?enquiry=x${'a'.repeat(40)}`, agency],
      [`${agency}?page=2&enquiry=sent&enquiry=sent`, `${agency}?page=2`],
      [`${listing}?enquiry=%3Cscript%3E`, listing],
      ['/en/properties?enquiry=nope', '/en/properties'],
    ];
    for (const [from, to] of cases) {
      const res = await run(request(from));
      expect(res.status, from).toBe(301);
      expect(res.headers.get('location'), from).toBe(`https://inmolink.test${to}`);
    }
    // Another spelling of the page's query keeps a known notice.
    const respelled = await run(request(`${agency}?page=1&enquiry=sent`));
    expect(respelled.headers.get('location')).toBe(`https://inmolink.test${agency}?enquiry=sent`);
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

describe('legacy inmolink.es URLs (S15-02)', () => {
  const allow: PortalGate = async () => ({ allowed: true, retryAfterSeconds: 0 });
  const known: Record<string, { targetPath: string; status: 301 | 308 }> = {
    '/property-details/AB-123/villa-in-rojales': { targetPath: '/es/property/villa-en-rojales-ab12cd34', status: 301 },
    '/agent/42/jane-doe': { targetPath: '/en/properties', status: 301 },
    '/?page_id=12': { targetPath: '/es', status: 301 },
    '/contacto.php': { targetPath: '/es', status: 308 },
    '/evil': { targetPath: '//evil.example/', status: 301 },
    '/evil2': { targetPath: 'https://evil.example/', status: 301 },
  };
  /** The resolver: a cached answer for a known path; a probe (after `beforeProbe`) otherwise. */
  const legacy: LegacyGate = vi.fn(async (path, beforeProbe) => {
    const hit = known[path];
    if (hit) return hit;
    await beforeProbe();
    return null;
  });

  it('[S15-02] a legacy URL answers 301 (or its own 308) to its new page before locale routing; Location is a path', async () => {
    const run = createProxy(ok(), allow, legacy);
    for (const [from, to] of Object.entries(known).slice(0, 4)) {
      const res = await run(request(from, { host: 'attacker.example' }));
      expect(res.status, from).toBe(to.status);
      expect(res.headers.get('location'), from).toBe(`https://inmolink.test${to.targetPath}`);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('[S15-02] never a redirect off the portal; an outage or an unknown path falls through to the page', async () => {
    const run = createProxy(ok(), allow, legacy);
    for (const path of ['/evil', '/evil2']) expect((await run(request(path))).status, path).not.toBe(301);
    const broken = createProxy(ok(), allow, async () => {
      throw new Error('db down');
    });
    expect(getRedirectUrl(await broken(request('/property-details/AB-123/x', { 'accept-language': 'es' })))).toBe(
      'http://portal.test/es/property-details/AB-123/x',
    );
    // An old page with an extension that names nothing now: a plain 404.
    expect((await run(request('/unknown.php'))).status).toBe(404);
  });

  it('[S15-02] a lookup that needs a database probe counts against the client page limit first (429 past it)', async () => {
    const limited: PortalGate = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 7 }));
    const run = createProxy(ok(), limited, legacy);
    // A cached answer needs no probe: never limited.
    expect((await run(request('/agent/42/jane-doe', { 'x-forwarded-for': '9.9.9.9' }))).status).toBe(301);
    expect(limited).not.toHaveBeenCalled();
    const res = await run(request('/made-up-123', { 'x-forwarded-for': '9.9.9.9' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(limited).toHaveBeenCalledWith('9.9.9.9');
  });

  it('[S15-02] the portal page shapes and the bare root are not looked up (their pages ask only on a 404)', async () => {
    const counted: LegacyGate = vi.fn(async () => null);
    const run = createProxy(ok(), allow, counted);
    for (const path of [
      '/',
      '/en',
      '/es/',
      '/en/properties/spain',
      '/en/property/x-ab12cd34',
      '/es/zone/x',
      '/en/development/x',
    ]) {
      await run(request(path));
    }
    expect(counted).not.toHaveBeenCalled();
    await run(request('/en/old-page'));
    expect(counted).toHaveBeenCalledWith('/en/old-page', expect.any(Function));
  });

  it('[S15-02] old pages with an extension reach the proxy; sitemaps, robots.txt and the enquiry post do not', () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of ['/index.php', '/contacto.html', '/old/page.aspx']) expect(runs(url), url).toBe(true);
    for (const url of ['/sitemap.xml', '/sitemaps/en-listings-1.xml', '/robots.txt', '/api/portal/enquiry']) {
      expect(runs(url), url).toBe(false);
    }
  });
});

describe('listing and development page misses (S15 review)', () => {
  const legacy: LegacyGate = vi.fn(async (path) =>
    path === '/en/property/old-villa-zzzzzzzz'
      ? { targetPath: '/en/property/villa-in-x-ab12cd34', status: 301 as const }
      : null,
  );
  /** A gate like core's: a known code passes; anything else costs the client's limit first. */
  const gate =
    (knownSlugs: string[]): CodeGate =>
    async ({ slug }, beforeProbe) => {
      if (knownSlugs.includes(slug)) return 'known';
      return (await beforeProbe()) ? 'unknown' : 'limited';
    };

  it('[S15-01] review: a real listing passes unlimited; a made-up code is counted, asks the legacy URLs (301), else renders its 404', async () => {
    const counted: PortalGate = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const run = createProxy(ok(), counted, legacy, undefined, gate(['villa-in-x-ab12cd34']));
    const real = await run(request('/en/property/villa-in-x-ab12cd34', { 'x-forwarded-for': '9.9.9.9' }));
    expect(real.status).toBe(200);
    expect(counted).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    // A legacy URL in the listing shape: a true 301, the client counted once (the lookup does not count again).
    const old = await run(request('/en/property/old-villa-zzzzzzzz', { 'x-forwarded-for': '9.9.9.9' }));
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('https://inmolink.test/en/property/villa-in-x-ab12cd34');
    expect(counted).toHaveBeenCalledTimes(1);
    expect(legacy).toHaveBeenCalledWith('/en/property/old-villa-zzzzzzzz', expect.any(Function));
    // Made up, no legacy row: counted, then the page renders (its 404); a development too.
    for (const path of ['/en/property/x-yyyyyyyy', '/es/development/no-code-here']) {
      expect((await run(request(path, { 'x-forwarded-for': '9.9.9.9' }))).status, path).toBe(200);
    }
    expect(counted).toHaveBeenCalledTimes(3);
  });

  it('[S15-01] review: the gate gets the page kind and locale with the slug (canonical slugs are per kind and locale); another slug of a real code is counted, then renders its 301', async () => {
    const seen: unknown[] = [];
    const counted: PortalGate = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const canonicalOnly: CodeGate = async (page, beforeProbe) => {
      seen.push(page);
      if (page.slug === 'villa-in-x-ab12cd34' && page.kind === 'listing' && page.locale === 'en') return 'known';
      return (await beforeProbe()) ? 'known' : 'limited';
    };
    const run = createProxy(ok(), counted, legacy, undefined, canonicalOnly);
    expect((await run(request('/en/property/villa-in-x-ab12cd34', { 'x-forwarded-for': '9.9.9.9' }))).status).toBe(200);
    expect(counted).not.toHaveBeenCalled();
    expect((await run(request('/es/development/made-up-ab12cd34/', { 'x-forwarded-for': '9.9.9.9' }))).status).toBe(
      200,
    );
    expect(counted).toHaveBeenCalledTimes(1);
    // A known code: no legacy lookup (its page answers the 301 to the canonical slug).
    expect(legacy).not.toHaveBeenCalledWith('/es/development/made-up-ab12cd34/', expect.any(Function));
    expect(seen).toEqual([
      { kind: 'listing', locale: 'en', slug: 'villa-in-x-ab12cd34' },
      { kind: 'development', locale: 'es', slug: 'made-up-ab12cd34' },
    ]);
  });

  it('[S15-01] review: past the page limit, made-up codes get a 429 (no-store); real pages and outages still render', async () => {
    const limited: PortalGate = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 9 }));
    const run = createProxy(ok(), limited, legacy, undefined, gate(['villa-in-x-ab12cd34']));
    for (const path of ['/en/property/x-yyyyyyyy', '/en/development/x-yyyyyyyy']) {
      const res = await run(request(path, { 'x-forwarded-for': '9.9.9.9' }));
      expect(res.status, path).toBe(429);
      expect(res.headers.get('retry-after'), path).toBe('9');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    expect((await run(request('/en/property/villa-in-x-ab12cd34'))).status).toBe(200);
    const broken = createProxy(ok(), limited, legacy, undefined, async () => {
      throw new Error('db down');
    });
    expect((await broken(request('/en/property/x-yyyyyyyy'))).status).toBe(200);
  });
});
