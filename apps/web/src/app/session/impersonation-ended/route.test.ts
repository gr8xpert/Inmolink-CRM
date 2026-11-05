import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a browser holding an impersonation that is over lands (S17-F46). Real `server/impersonation` over a cookie jar:
 * the assertion that matters is what the mint would read next, which is what the redirect loop was made of.
 */

const auth = vi.fn();
const fetchStaffMe = vi.fn();
const jar = new Map<string, string>();

vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('@/i18n/routing', () => ({ routing: { locales: ['en', 'es'], defaultLocale: 'en' } }));
vi.mock('@/server/staff-api', () => ({ fetchStaffMe: (s: unknown) => fetchStaffMe(s) }));
vi.mock('@/server/api', () => ({ sessionRef: (u: { id: string }) => ({ userId: u.id }) }));
vi.mock('@/server/env', () => ({ webConfig: async () => ({ WEB_URL: 'http://web.test' }) }));
vi.mock('next-intl', () => ({ hasLocale: (all: string[], l: string) => all.includes(l) }));
vi.mock('next-intl/server', () => ({
  getTranslations:
    async ({ locale }: { locale: string }) =>
    (key: string) =>
      `${locale}:${key}`,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    has: (name: string) => jar.has(name),
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string, opts: { maxAge?: number; expires?: Date }) => {
      if (opts.maxAge === 0 || (opts.expires && opts.expires.getTime() <= Date.now())) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { hasImpersonationCookie, readImpersonation, rememberImpersonation } = await import('@/server/impersonation');
const { GET } = await import('./route');

const STAFF = '01900000-0000-7000-8000-0000000000aa';
const SESSION = '01900000-0000-7000-8000-0000000000bb';
const OTHER = '01900000-0000-7000-8000-0000000000cc';
const CONSOLE = 'REDIRECT /staff/tenants?notice=ended';
const staffMe = (impersonation: { id: string } | null) => ({ ok: true, data: { role: 'SUPPORT', impersonation } });

async function hold(): Promise<void> {
  await rememberImpersonation(STAFF, {
    id: SESSION,
    agencyId: OTHER,
    agencyName: 'Costa',
    userName: 'Marta',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  } as Parameters<typeof rememberImpersonation>[1]);
}

describe('/session/impersonation-ended', () => {
  beforeEach(() => {
    jar.clear();
    auth.mockReset().mockResolvedValue({ user: { id: STAFF } });
    fetchStaffMe.mockReset();
  });

  it('[S17-F46] ended elsewhere: nothing mints from the cookie any more, and the banner can still say so', async () => {
    await hold();
    fetchStaffMe.mockResolvedValue(staffMe(null));
    await expect(GET()).rejects.toThrow(CONSOLE);
    // What the mint reads: nothing, so the console renders as the staff member and the chain ends here.
    expect(await readImpersonation(STAFF)).toBeNull();
    expect(await readImpersonation(STAFF, { includeEnded: true })).toMatchObject({ id: SESSION, ended: true });
    // Reached again (an old tab): the same answer.
    await expect(GET()).rejects.toThrow(CONSOLE);
    expect(await readImpersonation(STAFF)).toBeNull();
  });

  it('[S17-F46] a newer session of the same staff member does not keep the old one alive', async () => {
    await hold();
    fetchStaffMe.mockResolvedValue(staffMe({ id: OTHER }));
    await expect(GET()).rejects.toThrow(CONSOLE);
    expect(await readImpersonation(STAFF)).toBeNull();
  });

  it('[S17-F46] a stray GET changes nothing while the API says the session is live', async () => {
    await hold();
    fetchStaffMe.mockResolvedValue(staffMe({ id: SESSION }));
    await expect(GET()).rejects.toThrow(/^REDIRECT \/$/);
    expect(await readImpersonation(STAFF)).toMatchObject({ id: SESSION });
  });

  it('[S17-F46] staff access withdrawn mid-session: the cookie goes and the console is not offered', async () => {
    await hold();
    fetchStaffMe.mockResolvedValue({ ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    await expect(GET()).rejects.toThrow(/^REDIRECT \/$/);
    expect(await hasImpersonationCookie()).toBe(false);
  });

  it('[S17-F46] a disabled staff login is signed out; the cookie left behind mints nothing for anyone else', async () => {
    await hold();
    fetchStaffMe.mockResolvedValue('revoked');
    await expect(GET()).rejects.toThrow('REDIRECT /session/expired');
    expect(await readImpersonation(OTHER)).toBeNull();
  });

  it('[S17-F46] the API unreachable: no confirmation, no change, and an answer instead of another redirect', async () => {
    await hold();
    fetchStaffMe.mockResolvedValue({ ok: false, status: 0, error: null });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.text()).toBe('en:impersonation.endedUnconfirmed');
    expect(await readImpersonation(STAFF)).toMatchObject({ id: SESSION });
  });

  it('[S17-F46] natural expiry: an expired session is never minted from, and marking it just drops the cookie', async () => {
    jar.set(
      'inmolink.impersonation',
      Buffer.from(
        JSON.stringify({
          id: SESSION,
          staffUserId: STAFF,
          agencyId: OTHER,
          agencyName: 'Costa',
          userName: 'Marta',
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      ).toString('base64url'),
    );
    expect(await readImpersonation(STAFF)).toBeNull();
    fetchStaffMe.mockResolvedValue(staffMe(null));
    await expect(GET()).rejects.toThrow(CONSOLE);
    expect(await hasImpersonationCookie()).toBe(false);
  });

  it('[S17-F46] signed out: to the login, no lookup', async () => {
    auth.mockResolvedValue(null);
    await expect(GET()).rejects.toThrow('REDIRECT /login');
    expect(fetchStaffMe).not.toHaveBeenCalled();
  });
});
