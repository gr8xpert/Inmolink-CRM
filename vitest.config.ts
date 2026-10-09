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
    ],
  },
});
