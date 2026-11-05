import { type ComponentType, isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ClientModeUnavailable } from '@/components/shell/client-mode-unavailable';

const shell = vi.hoisted(() => ({ identity: { kind: 'member', role: 'AGENCY_ADMIN', caps: { clientMode: true } } }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/server/shell', () => ({ loadShell: async () => shell }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: () => null,
  getPathname: () => '/',
  redirect: () => {
    throw new Error('unexpected redirect');
  },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('unexpected notFound');
  },
  redirect: () => {
    throw new Error('unexpected redirect');
  },
}));
// Pages that must not ask the API in Client Mode: any fetch would fail the test.
const refuse = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (_t, name) => (name === 'then' ? undefined : () => Promise.reject(new Error('the API must not be asked'))),
      },
    ),
);
vi.mock('@/server/api', () => ({ sessionRef: () => ({}), ...refuse }));
vi.mock('@/server/calendar-api', () => refuse);
vi.mock('@/server/crm-api', () => refuse);
vi.mock('@/server/contacts-api', () => refuse);
vi.mock('@/server/chat-api', () => refuse);
vi.mock('@/server/social-api', () => refuse);
vi.mock('@/server/collaborations-api', () => refuse);
vi.mock('@/server/agency-time-zone', () => ({
  agencyTimeZone: () => Promise.reject(new Error('the API must not be asked')),
}));

/**
 * Client Mode closes the CRM, chat and social policies (`CLIENT_MODE_ALLOWED` is empty in each), so these pages show the
 * one deliberate sentence and no forms instead of "could not be loaded" or a refusal (S17-F45).
 */
type Page = (props: never) => Promise<unknown>;
const search = { searchParams: Promise.resolve({}) };
const PAGES: Array<[string, () => Promise<{ default: unknown }>, unknown]> = [
  ['calendar', () => import('./calendar/page'), search],
  ['tasks', () => import('./tasks/page'), search],
  ['inbox', () => import('./inbox/page'), search],
  ['inbox/[id]', () => import('./inbox/[id]/page'), { params: Promise.resolve({ id: 'x' }) }],
  ['chat', () => import('./chat/page'), search],
  ['chat/[id]', () => import('./chat/[id]/page'), { params: Promise.resolve({ id: 'x' }), ...search }],
  ['social', () => import('./social/page'), search],
  ['social/new', () => import('./social/new/page'), search],
  ['social/callback', () => import('./social/callback/page'), search],
  ['pipeline', () => import('./pipeline/page'), search],
  ['pipeline/stages', () => import('./pipeline/stages/page'), search],
  ['collaborations', () => import('./collaborations/page'), search],
  // S17-F56: the new collaboration routes stay closed too.
  ['collaborations/register', () => import('./collaborations/register/page'), search],
  [
    'collaborations/viewings/[id]/terms',
    () => import('./collaborations/viewings/[id]/terms/page'),
    { params: Promise.resolve({ id: 'x' }) },
  ],
];

describe('Client Mode on pages the API closes', () => {
  for (const [name, load, props] of PAGES) {
    it(`[S17-F45] ${name} shows the Client Mode sentence and asks the API for nothing`, async () => {
      const mod = await load();
      const out = await (mod.default as Page)(props as never);
      expect(isValidElement(out)).toBe(true);
      expect((out as { type: ComponentType }).type).toBe(ClientModeUnavailable);
      // The first page's import compiles the shared app code, about 20 s alone and more beside other test files.
    }, 120_000);
  }
});
