import { describe, expect, it } from 'vitest';
import { routing } from './routing';

describe('dashboard locale routing', () => {
  it('[S17-F56] the locale cookie is sent over HTTPS only (security test 2026-11-06)', () => {
    expect(routing.localeCookie).toMatchObject({ secure: true });
  });
});
