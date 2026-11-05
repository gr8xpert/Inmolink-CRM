import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The chat inbox's "new chat" control (S17-F50): colleagues of the agency, none, or acting as a member. */

const h = vi.hoisted(() => ({
  members: [] as Array<{ userId: string; name: string; status: string }>,
  acting: false,
  fetchColleagues: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'me' } }) }));
vi.mock('@/server/shell', () => ({
  loadShell: async () => ({
    identity: { kind: 'member', role: 'AGENT', caps: { clientMode: false, impersonating: h.acting } },
  }),
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getFormatter: async () => ({ dateTime: () => 'x' }),
  getTranslations: async () => Object.assign((k: string) => k, { has: () => false }),
}));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, getPathname: () => '/', redirect: () => undefined }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));
vi.mock('@/server/api', () => ({ sessionRef: () => ({}) }));
vi.mock('./actions', () => ({ startDirectChatAction: async () => undefined }));
vi.mock('@/server/chat-api', () => ({
  fetchThreads: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
  fetchColleagues: (...a: unknown[]) => {
    h.fetchColleagues(...a);
    return Promise.resolve({ ok: true, data: { items: h.members } });
  },
}));

const render = async () => {
  const mod = await import('./page');
  return renderToStaticMarkup(await mod.default({ searchParams: Promise.resolve({}) }));
};

describe('chat inbox: new chat', () => {
  beforeEach(() => {
    h.acting = false;
    h.fetchColleagues.mockClear();
  });

  it('[S17-F50] offers the active colleagues, not me nor deactivated members', async () => {
    h.members = [
      { userId: 'me', name: 'Myself', status: 'ACTIVE' },
      { userId: 'a', name: 'Ana Colleague', status: 'ACTIVE' },
      { userId: 'b', name: 'Gone Person', status: 'DEACTIVATED' },
    ];
    const html = await render();
    expect(html).toContain('data-testid="chat-new"');
    expect(html).toContain('Ana Colleague');
    expect(html).not.toContain('Myself');
    expect(html).not.toContain('Gone Person');
  });

  it('[S17-F50] says so when the agency has no other member', async () => {
    h.members = [{ userId: 'me', name: 'Myself', status: 'ACTIVE' }];
    const html = await render();
    expect(html).toContain('chat-no-colleagues');
    expect(html).not.toContain('data-testid="chat-new"');
  });

  it('[S17-F50] is not offered (and no roster fetched) while staff act as the member', async () => {
    h.acting = true;
    h.members = [{ userId: 'a', name: 'Ana Colleague', status: 'ACTIVE' }];
    const html = await render();
    expect(html).not.toContain('chat-new');
    expect(h.fetchColleagues).not.toHaveBeenCalled();
  });
});
