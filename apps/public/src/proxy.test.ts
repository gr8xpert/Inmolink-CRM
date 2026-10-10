import { UI_LOCALES } from '@inmolink/i18n';
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import proxy, { config } from './proxy';

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, 'http://portal.test'), { headers });

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
