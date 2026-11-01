import { UI_LOCALES } from '@inmolink/i18n';
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import nextConfig, { HANDLER_CSP, HANDLER_SOURCE } from '../next.config';
import { config, createProxy } from './proxy';
import { cspSourcesOf, dashboardCsp, newNonce, TURNSTILE_ORIGIN } from './server/csp';

/** The test stack's hosts (unit tests read no env). */
const proxy = createProxy(async () =>
  cspSourcesOf({
    S3_ENDPOINT: 'http://localhost:9000',
    REALTIME_PUBLIC_URL: 'http://localhost:4002',
    MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
  }),
);

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, 'http://web.test'), { headers });

describe('web locale routing', () => {
  it('[S0-11] an unprefixed path redirects to the Accept-Language locale', async () => {
    const es = await proxy(request('/login?verified=1', { 'accept-language': 'es-ES,es;q=0.9' }));
    expect(getRedirectUrl(es)).toBe('http://web.test/es/login?verified=1');
    const fallback = await proxy(request('/signup', { 'accept-language': 'ja' }));
    expect(getRedirectUrl(fallback)).toBe('http://web.test/en/signup');
  });

  it('[S0-11] a prefixed path is served in its locale, whatever the browser prefers', async () => {
    for (const locale of UI_LOCALES) {
      const res = await proxy(request(`/${locale}/login`, { 'accept-language': 'xx' }));
      expect(getRedirectUrl(res)).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it('[S0-11] route handlers and assets bypass locale routing', () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    expect(runs('/login')).toBe(true);
    expect(runs('/es/verify-email')).toBe(true);
    // Only the exact route-handler prefixes are skipped.
    expect(runs('/sessions')).toBe(true);
    expect(runs('/api-docs')).toBe(true);
    for (const url of [
      '/healthz',
      '/session/token',
      '/session/expired',
      '/api/auth/session',
      '/_next/static/x.js',
      '/favicon.ico',
    ]) {
      expect(runs(url)).toBe(false);
    }
  });
});

describe('dashboard security headers (S16-03)', () => {
  const cspOf = (res: Response) => res.headers.get('content-security-policy') ?? '';

  it('[S16-03] every page answer has a nonce CSP (no inline or eval scripts, no framing) with a fresh nonce each time', async () => {
    const a = await proxy(request('/en/login'));
    const b = await proxy(request('/en/login'));
    const nonceOf = (csp: string) => /'nonce-([A-Za-z0-9+/=]{20,})'/.exec(csp)?.[1];
    expect(nonceOf(cspOf(a))).toBeDefined();
    expect(nonceOf(cspOf(a))).not.toBe(nonceOf(cspOf(b)));
    const scriptSrc = /script-src ([^;]+)/.exec(cspOf(a))?.[1] ?? '';
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
      expect(cspOf(a)).toContain(directive);
    }
    // Next reads the nonce from the request's CSP while rendering: the proxy forwards both.
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(cspOf(a));
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(nonceOf(cspOf(a)));
    // The locale redirect carries it too.
    const redirect = await proxy(request('/login'));
    expect(getRedirectUrl(redirect)).not.toBeNull();
    expect(cspOf(redirect)).toContain("frame-ancestors 'none'");
  });

  const directive = (csp: string, name: string) => new RegExp(`(?:^|; )${name} ([^;]+)`).exec(csp)?.[1] ?? '';

  it('[S16-03] images, uploads and sockets reach only the configured hosts (no https:/wss: wildcards)', () => {
    const sources = cspSourcesOf({
      MEDIA_CDN_URL: 'https://media.inmolink.es/variants',
      S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
      REALTIME_PUBLIC_URL: 'https://realtime.inmolink.es',
      MAP_STYLE_URL: 'https://maps.example/style.json',
      MAP_TILE_ORIGINS: 'https://tiles.example/v1, https://glyphs.example ,javascript:alert(1),not a url',
    });
    const csp = dashboardCsp('n0nce', false, sources);
    expect(directive(csp, 'img-src').split(' ')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://media.inmolink.es',
      'https://acc.r2.cloudflarestorage.com',
      'https://maps.example',
      'https://tiles.example',
      'https://glyphs.example',
    ]);
    expect(directive(csp, 'connect-src').split(' ')).toEqual([
      "'self'",
      'https://acc.r2.cloudflarestorage.com',
      'https://realtime.inmolink.es',
      'wss://realtime.inmolink.es',
      'https://maps.example',
      'https://tiles.example',
      'https://glyphs.example',
      TURNSTILE_ORIGIN,
    ]);
    // Video previews (blob:) and uploaded media play from the same hosts.
    expect(directive(csp, 'media-src').split(' ')).toEqual(["'self'", 'blob:', 'data:', ...sources.images]);
    // No scheme wildcards anywhere; the dashboard API (called server-side only) is not reachable from the browser.
    expect(csp).not.toMatch(/(?:^|\s)(?:https?|wss?):(?:\s|;|$)/);
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain("'unsafe-eval'");
    // Unset optional hosts add nothing.
    const bare = cspSourcesOf({ REALTIME_PUBLIC_URL: 'https://rt.example', MAP_STYLE_URL: 'https://m.example/s.json' });
    expect(bare.images).toEqual(['https://m.example']);
  });

  it('[S16-03] dev and test stacks keep working: localhost hosts, eval for React debugging, the HMR socket', () => {
    const local = cspSourcesOf({
      MEDIA_CDN_URL: 'http://localhost:9000/inmolink-media',
      S3_ENDPOINT: 'http://localhost:9000',
      REALTIME_PUBLIC_URL: 'http://localhost:4002',
      MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
    });
    const dev = dashboardCsp('n', true, local);
    expect(directive(dev, 'img-src')).toContain('http://localhost:9000');
    expect(directive(dev, 'connect-src')).toContain('http://localhost:9000');
    expect(directive(dev, 'connect-src')).toContain('ws://localhost:4002');
    expect(directive(dev, 'connect-src')).toContain('ws://localhost:*');
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain('upgrade-insecure-requests');
    // A production build on the test stack (e2e): local hosts, no eval, no HMR socket.
    const built = dashboardCsp('n', false, local);
    expect(directive(built, 'connect-src')).toContain('http://localhost:4002');
    expect(built).not.toContain('ws://localhost:*');
    expect(newNonce()).not.toBe(newNonce());
  });

  it('[S16-03] dotted paths run the proxy (page CSP even on a 404); only static asset extensions skip it', () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of ['/en/x.php', '/en/listings/a.b', '/index.html', '/en/report.pdf']) {
      expect(runs(url), url).toBe(true);
    }
    for (const url of ['/maplibre/maplibre-gl-worker.mjs', '/favicon.ico', '/logo.svg', '/a.woff2', '/robots.txt']) {
      expect(runs(url), url).toBe(false);
    }
  });

  it('[S16-03] next.config: every path is unframeable, nosniff, HSTS; route handlers get a CSP that allows nothing', async () => {
    const rules = await (
      nextConfig as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }
    ).headers();
    const all = rules.find((r) => r.source === '/:path*');
    const names = Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
    expect(names['X-Frame-Options']).toBe('DENY');
    expect(names['X-Content-Type-Options']).toBe('nosniff');
    expect(names['Strict-Transport-Security']).toMatch(/max-age=\d{8}/);
    expect(names['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    const handlers = rules.find((r) => r.source === HANDLER_SOURCE);
    expect(handlers?.headers).toEqual([{ key: 'Content-Security-Policy', value: HANDLER_CSP }]);
    const handlerRe = /^\/(?:api|session|healthz)(?:\/.*)?$/;
    for (const p of ['/api/auth/session', '/session/token', '/healthz']) expect(p).toMatch(handlerRe);
    // The email-link pages' no-referrer rule comes after the global one, so it wins.
    const last = rules.at(-1);
    expect(last?.headers).toEqual([{ key: 'Referrer-Policy', value: 'no-referrer' }]);
  });
});
