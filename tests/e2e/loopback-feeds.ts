import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';

/**
 * Preloaded (`--import`) by the e2e api and worker (S6-04): lets `safeFetch` reach the fixture feed host on loopback
 * and nothing else. The allowance exists for tests only and checks `VITEST`; the flag is set just for this call.
 */
const port = process.env.E2E_FEED_PORT;
// S7-F1: never in production (the allowance refuses it too; CI checks no production start command preloads this file).
if (process.env.NODE_ENV === 'production') throw new Error('loopback-feeds is for the e2e stack only');
if (port) {
  process.env.VITEST = 'true';
  try {
    allowLoopbackOriginsForTests([`http://127.0.0.1:${port}`]);
  } finally {
    delete process.env.VITEST;
  }
}
