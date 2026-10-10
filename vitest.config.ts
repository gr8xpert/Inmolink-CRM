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
        // `pnpm test:boundaries` (S0-12): gen:module output and planted boundary violations, in a sandbox
        // copy of the workspace. Spawns tsc, Biome and dependency-cruiser, so it gets generous timeouts.
        test: {
          name: 'boundaries',
          include: ['tests/boundaries/**/*.test.ts'],
          environment: 'node',
          pool: 'threads',
          testTimeout: 300_000,
          hookTimeout: 180_000,
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
        // Cache, rate limits and feature flags against the test stack (redis-cache + Postgres). Files run
        // one at a time: parallel forks next to the queue project crashed workers on Windows (0xC0000409).
        ssr: { resolve: { conditions: ['@inmolink/source', 'node'] } },
        resolve: { conditions: ['@inmolink/source', 'import', 'module', 'default'] },
        test: {
          name: 'adapters',
          include: ['tests/adapters/**/*.int.test.ts'],
          environment: 'node',
          fileParallelism: false,
          globalSetup: ['tests/infra/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        // Each Node app's real main.ts against the test stack: config, boot, /readyz, SIGTERM (S0-08).
        test: {
          name: 'apps',
          include: ['tests/apps/**/*.int.test.ts'],
          environment: 'node',
          // Threads, not forks: a fork worker that spawns and kills children hit the Windows 0xC0000409 abort.
          pool: 'threads',
          fileParallelism: false,
          globalSetup: ['tests/infra/global-setup.ts'],
          testTimeout: 120_000,
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
