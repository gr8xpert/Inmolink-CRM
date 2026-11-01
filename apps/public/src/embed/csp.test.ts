// @ts-expect-error — Next's own compiled path-to-regexp (what `headers()` sources are matched with) has no types.
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';
import { describe, expect, it } from 'vitest';
import nextConfig, { FRAME_DENY_HEADERS, NOT_EMBED_SOURCE, PUBLIC_SECURITY_HEADERS } from '../../next.config';
import { EMBED_SCRIPT, EMBED_SCRIPT_PATH } from './client';
import { DENY_FRAMING, embedCsp, embedPath } from './csp';

describe('embed CSP and framing headers (S7-F8)', () => {
  it('[S7-F8] frame-ancestors lists only https host sources; nothing else can be smuggled into the policy', () => {
    const csp = embedCsp({
      frameAncestors: [
        'https://www.costa-homes.example',
        '*',
        'https://*.evil.example',
        "https://evil.example 'unsafe-inline'",
        'https://evil.example;script-src *',
        'http://plain.example',
      ],
      mediaOrigin: 'https://media.example',
    });
    expect(/frame-ancestors ([^;]+)$/.exec(csp)?.[1]).toBe('https://www.costa-homes.example');
    expect(embedCsp({ frameAncestors: [], mediaOrigin: null })).toContain("frame-ancestors 'none'");
    // Static: scripts from 'self' and Turnstile only — no nonce, no inline or eval'd script.
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(csp).not.toMatch(/nonce|unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(csp).toContain("img-src 'self' data: https://media.example");
  });

  it('[S7-F8] next.config denies framing on every path except the embeds (route handlers included)', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === NOT_EMBED_SOURCE);
    expect(rule?.headers).toEqual(FRAME_DENY_HEADERS);
    expect(Object.fromEntries(FRAME_DENY_HEADERS.map((h) => [h.key, h.value]))).toEqual(DENY_FRAMING);
    const re: RegExp = pathToRegexp(NOT_EMBED_SOURCE, [], {});
    for (const path of ['/', '/en', '/en/search', '/healthz', '/api/revalidate', '/embedded', '/en/embed/x']) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ['/embed', '/embed/x', '/embed/01900000-0000-7000-8000-0000000000aa/en/listing/CH-1']) {
      expect(re.test(path), path).toBe(false);
    }
  });

  it('[S16-F8] a selection page keeps its own CSP (script-src included): no next.config rule replaces it', async () => {
    const re: RegExp = pathToRegexp(NOT_EMBED_SOURCE, [], {});
    for (const path of ['/s/abcDEF123_-', '/s/abcDEF123_-/']) expect(re.test(path), path).toBe(false);
    // Anything else under `/s` (no selection route answers it) still may not be framed.
    for (const path of ['/s', '/s/a/b', '/sitemap.xml', '/search']) expect(re.test(path), path).toBe(true);
    const rules = (await nextConfig.headers?.()) ?? [];
    const csp = rules.filter((r) => r.headers.some((h) => h.key.toLowerCase() === 'content-security-policy'));
    expect(csp.map((r) => r.source)).toEqual([NOT_EMBED_SOURCE]);
    // The page's own policy: frames nothing, runs no inline script.
    const own = embedCsp({ frameAncestors: [], mediaOrigin: null });
    expect(own).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
    expect(own).toContain("frame-ancestors 'none'");
  });

  it('[S7-F8] embed paths: a site id and a language, anything else is invalid', () => {
    const site = '01900000-0000-7000-8000-0000000000aa';
    expect(embedPath(`/embed/${site}/es/listing/X`)).toEqual({ siteId: site, lang: 'es' });
    expect(embedPath(`/embed/${site}/en`)).toEqual({ siteId: site, lang: 'en' });
    for (const p of [
      '/embed',
      '/embed/',
      `/embed/${site}`,
      `/embed/${site}/eng`,
      '/embed/x/en',
      `/embed/${site.toUpperCase()}/en`,
    ]) {
      expect(embedPath(p), p).toBe('invalid');
    }
    expect(embedPath('/en/search')).toBeNull();
    expect(embedPath('/embedded')).toBeNull();
  });

  it('[S7-F8] the one embed script is self-contained, content-hashed and touches no cookie or storage', () => {
    expect(EMBED_SCRIPT_PATH).toMatch(/^\/embed-assets\/embed\.[0-9a-f]{12}\.js$/);
    // Parses as a script and refers to nothing but browser globals.
    expect(() => new Function(EMBED_SCRIPT)).not.toThrow();
    expect(EMBED_SCRIPT).not.toMatch(/\brequire\(|\bimport\b|document\.cookie|localStorage|sessionStorage/);
    // The idempotency key is made in the browser; Turnstile loads on first use of the form.
    expect(EMBED_SCRIPT).toContain('randomUUID');
    expect(EMBED_SCRIPT).toContain('focusin');
    // It posts urlencoded (the only body the route reads), never multipart.
    expect(EMBED_SCRIPT).toContain('new URLSearchParams(new FormData(');
    expect(EMBED_SCRIPT.length).toBeLessThan(4_000);
  });
});

describe('public security headers (S16-03)', () => {
  it('[S16-03] every path (embeds, route handlers, assets) is nosniff + HSTS; unframed pages refuse plugins, <base> and foreign form posts', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === '/:path*');
    expect(all?.headers).toEqual(PUBLIC_SECURITY_HEADERS);
    const names = Object.fromEntries(PUBLIC_SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(names['X-Content-Type-Options']).toBe('nosniff');
    expect(names['Strict-Transport-Security']).toMatch(/^max-age=\d{8}; includeSubDomains$/);
    const re: RegExp = pathToRegexp('/:path*', [], {});
    for (const path of [
      '/',
      '/en/property/x',
      '/embed/x/en',
      '/api/portal/enquiry',
      '/s/token',
      '/_next/static/a.js',
    ]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
      expect(DENY_FRAMING['Content-Security-Policy']).toContain(directive);
    }
  });
});
