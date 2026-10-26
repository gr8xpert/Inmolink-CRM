import { test as base } from '@playwright/test';
import type { Redis } from 'ioredis';
import { limitsRedis, resetRateLimits } from './rate-limits';

/**
 * The specs' `test` (S15-F5): every test starts with fresh rate-limit counters. The whole suite is one client — one
 * IP bucket — and its sign-ups, logins and 2FA codes add up past the per-IP auth limits (30 logins per 15 minutes)
 * as the suite grows: the last specs' logins were refused as "too many attempts". Each test is a new visitor.
 */
export const test = base.extend<{ freshRateLimits: undefined }, { limits: Redis }>({
  limits: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take their dependencies as a destructured object.
    async ({}, use) => {
      const redis = limitsRedis();
      await redis.connect();
      await use(redis);
      redis.disconnect();
    },
    { scope: 'worker' },
  ],
  freshRateLimits: [
    async ({ limits }, use) => {
      await resetRateLimits(limits);
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
