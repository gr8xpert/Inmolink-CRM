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
        conditions: ['@inmolink/source', 'import', 'default'],
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
