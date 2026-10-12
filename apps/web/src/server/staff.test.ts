import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The staff console's 404 (S1-09): `requireStaff` is the gate every staff page and the staff layout go
 * through. Next's `notFound()` is replaced by a throw the test can see.
 */

const auth = vi.fn();
const fetchStaffMe = vi.fn();

vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('./staff-api', () => ({ fetchStaffMe: (s: unknown) => fetchStaffMe(s) }));
vi.mock('./api', () => ({
  sessionRef: (u: { id: string; sessionVersion: number; mfaVerified: boolean }) => ({
    userId: u.id,
    sessionVersion: u.sessionVersion,
    mfaVerified: u.mfaVerified,
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { requireStaff } = await import('./staff');

const USER = { id: '01900000-0000-7000-8000-0000000000aa', sessionVersion: 1, mfaVerified: true };

describe('staff console gate', () => {
  beforeEach(() => {
    auth.mockReset();
    fetchStaffMe.mockReset();
  });

  it('[S1-09] non-staff get 404 on /staff routes: signed out, tenants and withdrawn staff alike', async () => {
    auth.mockResolvedValue(null);
    await expect(requireStaff()).rejects.toThrow('NOT_FOUND');
    expect(fetchStaffMe).not.toHaveBeenCalled();

    auth.mockResolvedValue({ user: USER });
    fetchStaffMe.mockResolvedValue({ ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    await expect(requireStaff()).rejects.toThrow('NOT_FOUND');

    // The API unreachable: still no page (fails closed).
    fetchStaffMe.mockResolvedValue({ ok: false, status: 0, error: null });
    await expect(requireStaff()).rejects.toThrow('NOT_FOUND');

    fetchStaffMe.mockResolvedValue('revoked');
    await expect(requireStaff()).rejects.toThrow('REDIRECT /session/expired');

    const me = { userId: USER.id, role: 'STAFF_SUPPORT', impersonation: null };
    fetchStaffMe.mockResolvedValue({ ok: true, data: me });
    await expect(requireStaff()).resolves.toMatchObject({ me, session: { userId: USER.id } });
  });

  it('[S1-09] non-staff get 404 on /staff routes: every staff page and the layout go through requireStaff', () => {
    const dir = join(import.meta.dirname, '..', 'app', '[locale]', 'staff');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /(^|[\\/])(page|layout)\.tsx$/.test(f),
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      expect(readFileSync(join(dir, f), 'utf8'), f).toMatch(/await requireStaff\(\)/);
    }
  });
});
