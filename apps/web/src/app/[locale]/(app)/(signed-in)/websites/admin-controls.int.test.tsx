import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { SiteDto, SiteFeedDto } from '@inmolink/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FeedCard } from './[id]/feed-card';
import { SiteForm } from './site-form';

const locale = vi.hoisted(() => ({ current: 'en' }));
const require = createRequire(import.meta.url);
const catalog = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(require.resolve(`@inmolink/i18n/messages/${locale.current}/${name}.json`), 'utf8'));
const lookup = (ns: string, key: string): string => {
  const root = catalog(ns.split('.')[0] as string);
  const path = [...ns.split('.').slice(1), ...key.split('.')];
  let cur: unknown = root;
  for (const p of path) cur = (cur as Record<string, unknown>)?.[p];
  return typeof cur === 'string' ? cur : `${ns}.${key}`;
};
vi.mock('next-intl/server', () => ({
  getLocale: async () => locale.current,
  getFormatter: async () => ({ dateTime: (d: Date) => d.toISOString() }),
  getTranslations: async (ns: string) => (key: string) => lookup(ns, key),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children?: unknown }) => children,
  getPathname: () => '/',
}));
vi.mock('./actions', () => ({ createSiteAction: vi.fn(), updateSiteAction: vi.fn() }));
vi.mock('./[id]/feed-actions', () => ({ revokeFeedAction: vi.fn(), rotateFeedAction: vi.fn() }));

const site = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Costa',
  mode: 'WP_PLUGIN',
  domains: [],
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: null,
  locales: ['en'],
  contact: null,
  version: 1,
} as unknown as SiteDto;
const feed = {
  enabled: true,
  tokenHint: 'ab12',
  tokenCreatedAt: '2026-11-01T10:00:00.000Z',
  generatedAt: null,
  itemCount: null,
  kyeroCount: null,
  lastError: null,
} as unknown as SiteFeedDto;

describe('website detail: controls only for admins', () => {
  for (const loc of ['en', 'es']) {
    it(`[S17-F44] a non-admin gets a disabled form without Save and no feed buttons (${loc})`, async () => {
      locale.current = loc;
      const form = renderToStaticMarkup(
        await SiteForm({ site, locations: [], propertyTypes: [], defaultLocales: ['en'], readOnly: true }),
      );
      expect(form).toContain('<fieldset disabled=""');
      expect(form).not.toContain('type="submit"');
      const card = renderToStaticMarkup(await FeedCard({ site, feed, admin: false }));
      expect(card).toContain('data-testid="feed-card"');
      expect(card).not.toContain('<button');
      expect(card).not.toContain('<form');
    });

    it(`[S17-F44] an admin keeps Save and the feed buttons (${loc})`, async () => {
      locale.current = loc;
      const form = renderToStaticMarkup(
        await SiteForm({ site, locations: [], propertyTypes: [], defaultLocales: ['en'] }),
      );
      expect(form).toContain('type="submit"');
      const card = renderToStaticMarkup(await FeedCard({ site, feed, admin: true }));
      expect(card).toContain('<button');
    });
  }
});
