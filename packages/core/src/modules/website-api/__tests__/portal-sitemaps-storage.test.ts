import { beforeEach, describe, expect, it, vi } from 'vitest';

/** S17-F39: a failing store does not make every request wait for the storage timeout. */

const get = vi.fn();
vi.mock('@inmolink/platform/storage', async (orig) => ({
  ...(await orig<typeof import('@inmolink/platform/storage')>()),
  storage: () => ({ get }),
}));

const { portalSitemapFile, resetPortalSitemapCache } = await import('../portal-sitemaps');

beforeEach(() => {
  get.mockReset();
  resetPortalSitemapCache();
});

describe('portal sitemap serving when the store fails', () => {
  it('[S17-F39] one failed manifest read answers the next requests at once, without asking the store again', async () => {
    get.mockRejectedValue(new Error('storage GET failed (TimeoutError)'));
    await expect(portalSitemapFile('sitemap.xml')).rejects.toThrow();
    const started = Date.now();
    await expect(portalSitemapFile('sitemap.xml')).rejects.toThrow('unavailable');
    await expect(portalSitemapFile('en-listings-1.xml')).rejects.toThrow('unavailable');
    expect(get).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('[S17-F39] no manifest yet is a plain "not found", remembered for the minute', async () => {
    get.mockResolvedValue(null);
    expect(await portalSitemapFile('sitemap.xml')).toBeNull();
    expect(await portalSitemapFile('sitemap.xml')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
