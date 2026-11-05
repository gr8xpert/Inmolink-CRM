import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ impersonating: true }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/server/shell', () => ({
  loadShell: async () => ({ identity: { kind: 'member', caps: { impersonating: h.impersonating } } }),
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getFormatter: async () => ({ dateTime: () => 'date', number: () => '1' }),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, getPathname: () => '/', redirect: () => null }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: () => {
    throw new Error('redirect');
  },
}));
vi.mock('@/server/api', () => ({ sessionRef: () => ({}) }));
vi.mock('@/components/open-file-form', () => ({ OpenFileForm: () => null }));
vi.mock('./actions', () => ({
  createTicketAction: async () => {},
  openAttachmentAction: async () => {},
  replyAction: async () => {},
  resolveAction: async () => {},
}));
const TICKET_ID = '01900000-0000-7000-8000-000000000001';
vi.mock('@/server/support-api', () => ({
  fetchSupportTickets: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
  fetchSupportTicket: async () => ({
    ok: true,
    data: {
      id: TICKET_ID,
      subject: 'Subject',
      category: 'OTHER',
      priority: 'NORMAL',
      status: 'OPEN',
      createdAt: '2026-11-05T00:00:00.000Z',
      messages: [],
      olderMessagesCursor: null,
      attachments: [],
    },
  }),
}));

const { default: SupportPage } = await import('./page');
const { default: SupportTicketPage } = await import('./[id]/page');

const list = async () => renderToStaticMarkup(await SupportPage({ searchParams: Promise.resolve({}) }));
const detail = async () =>
  renderToStaticMarkup(
    await SupportTicketPage({ params: Promise.resolve({ id: TICKET_ID }), searchParams: Promise.resolve({}) }),
  );

describe('support screens while acting as a member', () => {
  beforeEach(() => {
    h.impersonating = true;
  });

  it('[S17-F47] staff acting as a member are told they can read, and are offered no ticket form', async () => {
    const html = await list();
    expect(html).toContain('support-acting');
    expect(html).not.toContain('ticket-subject');
  });

  it('[S17-F47] staff acting as a member are offered no reply, resolve or upload on a ticket', async () => {
    const html = await detail();
    expect(html).toContain('support-acting');
    expect(html).not.toContain('reply-body');
    expect(html).not.toContain('ticket.resolve');
    expect(html).not.toContain('support-file');
  });

  it('[S17-F47] the member themselves keep every form', async () => {
    h.impersonating = false;
    expect(await list()).toContain('ticket-subject');
    const html = await detail();
    expect(html).toContain('reply-body');
    expect(html).toContain('ticket.resolve');
    expect(html).toContain('support-file');
  });
});
