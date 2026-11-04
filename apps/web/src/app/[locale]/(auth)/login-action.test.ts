import { describe, expect, it, vi } from 'vitest';

/** The sign-in action's messages (S17-F37): an empty submit is a form problem, a wrong password a credentials one. */

let code = 'input';
class AuthError extends Error {
  code?: string;
}
vi.mock('next-auth', () => ({ AuthError }));
vi.mock('@/auth', () => ({
  signIn: async () => {
    const err = new AuthError('x');
    err.code = code;
    throw err;
  },
  signOut: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({ getPathname: ({ href }: { href: string }) => href, redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/env', () => ({ webConfig: async () => ({}) }));
vi.mock('@/server/limits', () => ({ checkLimits: async () => 0, clientIp: () => '', LIMITS: {} }));
vi.mock('@/server/request-id', () => ({ requestAuthCtx: async () => ({}) }));
vi.mock('@/server/session-end', () => ({ revokeCurrentSession: async () => undefined }));
vi.mock('@/server/turnstile', () => ({ passesSignupChallenge: async () => true }));
vi.mock('@inmolink/core/modules/identity', () => ({}));

describe('loginAction messages', () => {
  it('[S17-F37] an empty submit says "check the highlighted fields", like the other forms', async () => {
    const { loginAction } = await import('./actions');
    code = 'input';
    expect(await loginAction({}, new FormData())).toEqual({ error: 'invalidInput' });
  });

  it('[S17-F37] a wrong password still says the credentials are incorrect', async () => {
    const { loginAction } = await import('./actions');
    code = 'invalid';
    expect(await loginAction({}, new FormData())).toEqual({ error: 'invalidCredentials' });
  });
});
