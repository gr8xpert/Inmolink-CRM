import { UI_LOCALES } from '@inmolink/i18n';
import { getRedirectUrl, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import proxy, { config } from './proxy';

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
