import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { PORTS, ROOT, testStackEnv } from './tests/e2e/stack';

/**
 * E2E (PLAN §15 critical flows) against the full local stack on the docker `test` profile:
 * api + worker (outbox, email) from source, web as a production build (`next start`; `pnpm test:e2e`
 * builds it and the workspace packages first). Not `next dev`: on-demand compiles and dev-server
 * reloads made the flows flaky (S1-F1). Emails land in the test Mailpit.
 */
const env = testStackEnv();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const node = (app: string) =>
  `node "${TSX}" --conditions=@inmolink/source --import @inmolink/platform/telemetry/register ${join('apps', app, 'src', 'main.ts')}`;
const common = { ...process.env, ...env, NODE_ENV: 'test', LOG_LEVEL: 'warn' };

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: env.WEB_URL,
    trace: 'retain-on-failure',
    locale: 'en-GB',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: node('api'),
      cwd: ROOT,
      url: `http://127.0.0.1:${PORTS.api}/readyz`,
      env: { ...common, API_PORT: String(PORTS.api) },
      // Warnings and errors only (LOG_LEVEL=warn): visible in the run's output, also in CI.
      stdout: 'pipe',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: node('worker'),
      cwd: ROOT,
      url: `http://127.0.0.1:${PORTS.workerHealth}/readyz`,
      env: { ...common, WORKER_POOLS: 'outbox,email', WORKER_HEALTH_PORT: String(PORTS.workerHealth) },
      stdout: 'pipe',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec next start --port ${PORTS.web}`,
      cwd: join(ROOT, 'apps', 'web'),
      url: `${env.WEB_URL}/healthz`,
      env: common,
      stdout: 'pipe',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
