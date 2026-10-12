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
      // Forks (the default): a worker crash (0xC0000409 on Windows under a parallel `verify`) then
      // kills one fork, not the whole run — with `threads` the core int suite died at startup twice.
      // `pnpm verify` caps Turbo at 4 parallel tasks for the same reason.
      include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
      // Sized for a full, non-affected `verify` on one machine (S1-F1): boot tests and `setupTestDb`
      // hooks blew Vitest's 5 s / 10 s defaults under parallel load and passed alone. Same as the
      // root projects; a slow test still fails, just not because the machine is busy.
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  });
}
