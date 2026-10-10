import { defineConfig } from 'vitest/config';

// Vitest workspace: `pnpm vitest` at the root runs every package; Turbo runs them per package.
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      {
        test: {
          name: 'workspace',
          include: ['tests/workspace/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Needs Docker: global setup starts the `test` compose profile.
        test: {
          name: 'infra',
          include: ['tests/infra/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['tests/infra/global-setup.ts'],
          testTimeout: 30_000,
        },
      },
      {
        // Outbox + queues against the test stack (Postgres + redis-queue). Files run one at a time:
        // fair-share timing assertions need a quiet event loop.
        ssr: { resolve: { conditions: ['@inmolink/source', 'node'] } },
        resolve: { conditions: ['@inmolink/source', 'import', 'module', 'default'] },
        test: {
          name: 'queue',
          include: ['tests/queue/**/*.int.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        // `pnpm test:perf:root`: throughput checks from acceptance criteria. Turbo runs this after every
        // other verify task so the measurement is not shared with parallel suites. Restarts redis-queue.
        ssr: { resolve: { conditions: ['@inmolink/source', 'node'] } },
        resolve: { conditions: ['@inmolink/source', 'import', 'module', 'default'] },
        test: {
          name: 'perf',
          include: ['tests/perf/**/*.int.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 180_000,
        },
      },
      {
        // `pnpm test:isolation`: cross-tenant suite generated from the tenant registry + RLS guard.
        // Files run one at a time: they create and drop shared fixture tables in schema public.
        ssr: { resolve: { conditions: ['@inmolink/source', 'node'] } },
        resolve: { conditions: ['@inmolink/source', 'import', 'module', 'default'] },
        test: {
          name: 'isolation',
          include: ['tests/isolation/**/*.int.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
