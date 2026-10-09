import { defineProject } from 'vitest/config';

/**
 * Per-package Vitest project. Unit tests: `*.test.ts`. Integration tests: `*.int.test.ts`
 * (selected by the `test` / `test:int` package scripts). Resolves workspace packages to
 * their TypeScript source through the `@inmolink/source` export condition.
 *
 * @param {{ environment?: 'node' | 'jsdom' | 'happy-dom' }} [options]
 */
export function inmolinkProject(options = {}) {
  return defineProject({
    ssr: {
      resolve: {
        // No explicit `import`: Vite adds import/require per import kind, and a listed `import` is
        // forwarded to Node, which then resolves CJS `require()` calls to ESM builds (breaks pg-pool).
        // This list replaces Vite's server defaults, so `module` and `development|production` are off too.
        conditions: ['@inmolink/source', 'node'],
      },
    },
    resolve: {
      conditions: ['@inmolink/source', 'import', 'module', 'browser', 'default'],
    },
    test: {
      environment: options.environment ?? 'node',
      include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    },
  });
}
