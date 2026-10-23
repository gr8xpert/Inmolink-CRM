import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../logger';
import { assertRule, RateLimiter, retryAfterMs } from './limiter';

const W = 60_000;

/** The sliding estimate the Lua script compares against the limit. */
const estimate = (elapsed: number, cur: number, prev: number) => (prev * (W - elapsed)) / W + cur;

describe('retryAfterMs', () => {
  it('waits for the previous window to slide out when the current one has room', () => {
    // limit 10, prev 10, cur 0, 30 s in: estimate 5, so one more fits now
    expect(retryAfterMs(10, W, 30_000, 0, 10, 1)).toBe(0);
    // limit 10, prev 10, cur 5 at 30 s: estimate 10; the prev part must drop from 5 to 4 → 30 s overlap → 24 s
    const t = retryAfterMs(10, W, 30_000, 5, 10, 1);
    expect(t).toBeCloseTo(6_000);
    expect(estimate(30_000 + t, 5, 10) + 1).toBeLessThanOrEqual(10.000001);
  });

  it('rolls into the next window when the current one is full', () => {
    // limit 3, cur 3 at 30 s: next window, cur becomes prev weighted (w − e′)/w; need 3·(w − e′)/w + 1 ≤ 3
    const t = retryAfterMs(3, W, 30_000, 3, 0, 1);
    expect(t).toBeCloseTo(30_000 + 20_000);
  });
});

describe('assertRule', () => {
  it('rejects bad names and bounds', () => {
    expect(() => assertRule({ name: 'Bad Name', scope: 'ip', limit: 1, windowSeconds: 1 })).toThrow(TypeError);
    expect(() => assertRule({ name: 'ok', scope: 'ip', limit: 0, windowSeconds: 1 })).toThrow(RangeError);
    expect(() => assertRule({ name: 'ok', scope: 'ip', limit: 1, windowSeconds: 0.5 })).toThrow(RangeError);
    expect(() => assertRule({ name: 'api.default', scope: 'ip', limit: 5, windowSeconds: 60 })).not.toThrow();
  });

  it('requires failClosed on credential rules', () => {
    expect(() => assertRule({ name: 'auth.login', scope: 'ip', limit: 5, windowSeconds: 60 })).toThrow(/failClosed/);
    expect(() =>
      assertRule({ name: 'auth.login', scope: 'ip', limit: 5, windowSeconds: 60, failClosed: true }),
    ).not.toThrow();
  });
});

describe('fail-open signal (S8-F9)', () => {
  it('[S8-F9] a failed script call marks fail-open answers; fail-closed rules deny without the flag', async () => {
    const redis = { status: 'end', defineCommand: () => {} } as unknown as Redis;
    const logger = { warn: () => {} } as unknown as Logger;
    const limiter = new RateLimiter({ redis, logger, hmacKey: 'k'.repeat(32) });
    const [open, closed] = await limiter.consumeMany([
      { rule: { name: 'feed.x', scope: 'ip', limit: 5, windowSeconds: 60 }, identity: 'a' },
      { rule: { name: 'auth.login', scope: 'ip', limit: 5, windowSeconds: 60, failClosed: true }, identity: 'a' },
    ]);
    expect(open).toMatchObject({ allowed: true, failedOpen: true });
    expect(closed).toMatchObject({ allowed: false });
    expect(closed?.failedOpen).toBeUndefined();
  });
});
