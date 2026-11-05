import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  shell: { identity: { kind: 'member', caps: { role: 'AGENCY_ADMIN', clientMode: false, impersonating: true } } },
  audit: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/server/shell', () => ({ loadShell: async () => h.shell }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getFormatter: async () => ({ dateTime: () => 'date' }),
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
vi.mock('@/server/api', () => ({
  sessionRef: () => ({}),
  fetchApiKeys: async () => ({ ok: true, data: { items: [] } }),
}));
vi.mock('@/server/staff', () => ({
  requireStaff: async () => ({ session: {}, me: { role: 'STAFF_SUPPORT' } }),
}));
vi.mock('@/server/staff-api', () => ({ fetchStaffAuditLog: h.audit }));

describe('screens for staff acting as a member and the audit viewer', () => {
  beforeEach(() => h.audit.mockReset());

  it('[S17-F48] API keys offer no create, rotate or revoke to staff acting as an admin, and say so', async () => {
    const { default: Page } = await import('./(signed-in)/api-keys/page');
    const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
    expect(html).toContain('actingUnavailable');
    expect(html).not.toContain('create-heading');
    expect(html).not.toContain('<form');
  });

  it('[S17-F48] an unreadable audit cursor starts from the first page instead of blaming the dates', async () => {
    const { default: Page } = await import('./staff/audit/page');
    h.audit
      .mockResolvedValueOnce({ ok: false, status: 400, error: { code: 'VALIDATION_FAILED' } })
      .mockResolvedValueOnce({ ok: true, data: { items: [], nextCursor: null } });
    const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ cursor: 'garbage' }) })) as never);
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[1]?.[1]).toMatchObject({ cursor: undefined });
    expect(html).not.toContain('badRange');
  });

  it('[S17-F48] an inverted date range still says the start must be before the end', async () => {
    const { default: Page } = await import('./staff/audit/page');
    h.audit.mockResolvedValue({ ok: false, status: 400, error: { code: 'VALIDATION_FAILED' } });
    const html = renderToStaticMarkup(
      (await Page({ searchParams: Promise.resolve({ from: '2026-05-02', to: '2026-05-01' }) })) as never,
    );
    expect(html).toContain('audit.badRange');
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
});
