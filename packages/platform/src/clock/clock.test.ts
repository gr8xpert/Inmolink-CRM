import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock, restoreClock, useFakeClock } from './index';

afterEach(() => {
  restoreClock();
  vi.useRealTimers();
});

describe('clock', () => {
  it('[S0-03] can be pinned and advanced in tests', () => {
    const fake = useFakeClock('2026-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    fake.advance(1500);
    expect(clock.nowMs()).toBe(Date.parse('2026-01-01T00:00:01.500Z'));
  });

  it('[S0-03] follows vi.useFakeTimers when no fake clock is installed', () => {
    vi.useFakeTimers({ now: new Date('2030-05-05T05:05:05Z') });
    expect(clock.now().toISOString()).toBe('2030-05-05T05:05:05.000Z');
  });

  it('[S0-03] rejects invalid times', () => {
    expect(() => useFakeClock('not a date')).toThrow(RangeError);
  });
});
