import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The XML feed card's rotate action (S7-F8): transport only — the form's idempotency key reaches the API. */

const rotateSiteFeed = vi.fn();
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1', sessionVersion: 1, mfaVerified: true } }) }));
vi.mock('@/server/api', () => ({
  rotateSiteFeed: (...args: unknown[]) => rotateSiteFeed(...args),
  revokeSiteFeed: vi.fn(),
  sessionRef: (u: unknown) => u,
}));
vi.mock('@/server/env', () => ({ webConfig: async () => ({ FEED_API_PUBLIC_URL: 'https://feed.example' }) }));
vi.mock('@/i18n/navigation', () => ({ getPathname: ({ href }: { href: string }) => href }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const SITE = '01900000-0000-7000-8000-0000000000aa';
const KEY = 'feed-0f6c2a52-6f3e-4a59-9d0e-4a3f5d1b2c3e';
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

beforeEach(() => {
  rotateSiteFeed.mockReset();
  rotateSiteFeed.mockResolvedValue({
    ok: true,
    data: { paths: { kyero: '/v2/feeds/T/kyero.xml', generic: '/v2/feeds/T/inmolink.xml' } },
  });
});

describe('XML feed card actions (S7-F8)', () => {
  it('[S7-F8] rotating sends the form’s Idempotency-Key, so a repeated submit answers the same token', async () => {
    const { rotateFeedAction } = await import('./feed-actions');
    const first = await rotateFeedAction({}, form({ siteId: SITE, idempotencyKey: KEY }));
    const again = await rotateFeedAction({}, form({ siteId: SITE, idempotencyKey: KEY }));
    expect(rotateSiteFeed).toHaveBeenCalledTimes(2);
    for (const call of rotateSiteFeed.mock.calls) expect(call.slice(1)).toEqual([SITE, KEY]);
    expect(first).toEqual({
      urls: {
        kyero: 'https://feed.example/v2/feeds/T/kyero.xml',
        generic: 'https://feed.example/v2/feeds/T/inmolink.xml',
      },
    });
    expect(again).toEqual(first);
    // No key, or a malformed one: refused before the API.
    expect(await rotateFeedAction({}, form({ siteId: SITE }))).toEqual({ error: 'generic' });
    expect(await rotateFeedAction({}, form({ siteId: SITE, idempotencyKey: 'bad key!' }))).toEqual({
      error: 'generic',
    });
    expect(rotateSiteFeed).toHaveBeenCalledTimes(2);
  });
});
