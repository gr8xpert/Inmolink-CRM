import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';

/**
 * Preloaded (`--import`) by the e2e api and worker (S6-04): lets `safeFetch` reach the fixture feed host on loopback
 * and nothing else. The allowance exists for tests only and checks `VITEST`; the flag is set just for this call.
 */
const port = process.env.E2E_FEED_PORT;
if (port) {
  process.env.VITEST = 'true';
  try {
    allowLoopbackOriginsForTests([`http://127.0.0.1:${port}`]);
  } finally {
    delete process.env.VITEST;
  }
}
