import { describe, expect, it, vi } from 'vitest';
import { embedCsp } from '@/embed/csp';
import { withSelectionHeaders } from './handlers';

vi.mock('@/server/embed', () => ({
  clientAddress: async () => ({ bucket: 'b' }),
  embedPageConfig: async () => ({ mediaOrigin: 'https://media.example' }),
}));
vi.mock('@/server/env', () => ({ LOCAL_PUBLIC_URL: 'http://localhost', publicConfig: async () => ({}) }));

const CSP = embedCsp({ frameAncestors: [], mediaOrigin: 'https://media.example' });

describe('selection page headers (S16-F8 review)', () => {
  it('[S16-F8] every selection answer — 403, 413, 303 and an uncaught failure — carries the selection headers', async () => {
    const cases: [string, () => Promise<Response>, number][] = [
      ['403', async () => new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } }), 403],
      ['413', async () => new Response(null, { status: 413 }), 413],
      ['303', async () => new Response(null, { status: 303, headers: { Location: '/s/t?n=sent' } }), 303],
      [
        'throws',
        async () => {
          throw new Error('database down');
        },
        500,
      ],
    ];
    for (const [name, answer, status] of cases) {
      const res = await withSelectionHeaders(answer);
      expect(res.status, name).toBe(status);
      expect(res.headers.get('content-security-policy'), name).toBe(CSP);
      expect(res.headers.get('content-security-policy'), name).toMatch(/script-src 'self' [^;]*;/);
      expect(res.headers.get('x-frame-options'), name).toBe('DENY');
      expect(res.headers.get('referrer-policy'), name).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag'), name).toBe('noindex, nofollow');
      expect(res.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(res.headers.get('cache-control'), name).toBe('no-store');
      // An empty answer is not called HTML.
      expect(res.headers.get('content-type'), name).toBeNull();
    }
    // The answer's own values win.
    const page = await withSelectionHeaders(
      async () =>
        new Response('<html></html>', {
          status: 429,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '7', Location: '/x' },
        }),
    );
    expect(page.headers.get('retry-after')).toBe('7');
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toBe('<html></html>');
  });
});
