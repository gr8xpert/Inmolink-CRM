import { describe, expect, it, vi } from 'vitest';
import { passesSignupChallenge, TURNSTILE_SIGNUP_ACTION } from './turnstile';

vi.mock('./env', () => ({ webConfig: async () => ({ TRUST_PROXY: 1 }) }));

const verifier = (result: boolean) => ({ verify: vi.fn(async () => result) });

describe('signup challenge', () => {
  it('[S17-F10] with Turnstile set up, a signup needs a solved token for the signup action', async () => {
    const yes = verifier(true);
    expect(await passesSignupChallenge('token', '203.0.113.9', yes)).toBe(true);
    expect(yes.verify).toHaveBeenCalledWith('token', expect.objectContaining({ action: TURNSTILE_SIGNUP_ACTION }));
    expect(await passesSignupChallenge('token', null, verifier(false))).toBe(false);
  });

  it('[S17-F10] a missing token is refused without asking Cloudflare', async () => {
    const yes = verifier(true);
    expect(await passesSignupChallenge(undefined, null, yes)).toBe(false);
    expect(await passesSignupChallenge('', null, yes)).toBe(false);
    expect(yes.verify).not.toHaveBeenCalled();
  });

  it('[S17-F10] without keys, signup is not blocked', async () => {
    expect(await passesSignupChallenge(undefined, null, null)).toBe(true);
  });
});
