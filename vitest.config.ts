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
