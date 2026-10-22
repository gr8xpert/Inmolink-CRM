import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatFiles, generateModule } from '../../scripts/gen/module';
import { createSandbox, type Sandbox } from './sandbox';

/**
 * S0-12 acceptance: `pnpm gen:module` output passes typecheck, lint and boundaries, and
 * `pnpm check:boundaries` fails on planted violations. Runs in a sandbox copy of the workspace.
 */
const MODULE = 'probe-listings';
const MODULE_DIR = `packages/core/src/modules/${MODULE}`;

let sb: Sandbox;
let touched: string[];

/** Writes a file in the sandbox for one test, then puts back what was there. */
async function planted<T>(path: string, content: string, fn: () => Promise<T>): Promise<T> {
  const abs = join(sb.root, path);
  let before: string | undefined;
  try {
    before = readFileSync(abs, 'utf8');
  } catch {
    before = undefined;
  }
  writeFileSync(abs, content);
  try {
    return await fn();
  } finally {
    if (before === undefined) rmSync(abs);
    else writeFileSync(abs, before);
  }
}

beforeAll(() => {
  sb = createSandbox();
  touched = generateModule(sb.root, MODULE, { routes: true });
  formatFiles(sb.root, touched);
});

afterAll(() => sb?.cleanup());

describe('module scaffolder and boundaries', () => {
  it('[S0-12] generated module passes typecheck, lint and boundaries', async () => {
    expect(touched).toEqual(
      expect.arrayContaining([
        `${MODULE_DIR}/index.ts`,
        `${MODULE_DIR}/service.ts`,
        `${MODULE_DIR}/repo.ts`,
        `${MODULE_DIR}/policy.ts`,
        `${MODULE_DIR}/events.ts`,
        `${MODULE_DIR}/jobs.ts`,
        `${MODULE_DIR}/errors.ts`,
        `${MODULE_DIR}/__tests__/policy.test.ts`,
        `packages/db/src/schema/${MODULE}.ts`,
        `packages/contracts/src/${MODULE}.ts`,
        `apps/api/src/routes/${MODULE}/routes.ts`,
        'packages/db/src/schema/index.ts',
        'packages/contracts/src/index.ts',
        'apps/api/src/app.ts',
        'apps/worker/src/subscriptions.ts',
      ]),
    );
    expect(readFileSync(join(sb.root, 'apps/worker/src/subscriptions.ts'), 'utf8')).toContain(
      "'probe-listings': probeListings",
    );
    expect(readFileSync(join(sb.root, 'apps/api/src/app.ts'), 'utf8')).toContain(
      'await app.register(probeListingsRoutes);',
    );

    // Two processes at a time: this runs inside `verify`, next to other suites.
    const results = [
      ...(await Promise.all([sb.typecheck('packages/core'), sb.typecheck('apps/api')])),
      ...(await Promise.all([sb.typecheck('packages/db'), sb.typecheck('packages/contracts')])),
      ...(await Promise.all([sb.typecheck('apps/worker')])),
      ...(await Promise.all([sb.biome(touched), sb.boundaries()])),
    ];
    for (const r of results) expect(r, r.output).toMatchObject({ code: 0 });
  });

  it('[S0-12] refuses to overwrite an existing module, and writes nothing when an anchor is missing', () => {
    expect(() => generateModule(sb.root, MODULE, { routes: false })).toThrow(/already exists/);
    expect(() => generateModule(sb.root, 'Bad_Name', { routes: false })).toThrow(/kebab-case/);

    const app = join(sb.root, 'apps/api/src/app.ts');
    const source = readFileSync(app, 'utf8');
    writeFileSync(app, source.replaceAll('await app.register(', 'await app.use('));
    try {
      expect(() => generateModule(sb.root, 'probe-orphan', { routes: true })).toThrow(/no "await app.register/);
      expect(existsSync(join(sb.root, 'packages/core/src/modules/probe-orphan'))).toBe(false);
      expect(readFileSync(join(sb.root, 'packages/db/src/schema/index.ts'), 'utf8')).not.toContain('probe-orphan');
    } finally {
      writeFileSync(app, source);
    }
  });

  it('[S0-12] app tests may use @inmolink/db/testing and nothing else from db', async () => {
    const allowed = await planted(
      'apps/api/src/planted.test.ts',
      "import { setupTestDb } from '@inmolink/db/testing';\nexport const planted = setupTestDb;\n",
      () => sb.boundaries(['apps/api/src/planted.test.ts']),
    );
    expect(allowed, allowed.output).toMatchObject({ code: 0 });

    const denied = await planted(
      'apps/api/src/planted.test.ts',
      "import { withSystem } from '@inmolink/db';\nexport const planted = withSystem;\n",
      () => sb.boundaries(['apps/api/src/planted.test.ts']),
    );
    expect(denied.code).not.toBe(0);
    expect(denied.output).toMatch(
      /apps-tests-thin-transports: apps\/api\/src\/planted\.test\.ts → packages\/db\/src\/index\.ts/,
    );
  });

  it("[S7-F11] a module's testing.ts (perf-test helpers) is for tests only: an app importing it fails", async () => {
    const result = await planted(
      'apps/api/src/planted.ts',
      "import { publicFallbackSql } from '@inmolink/core/modules/search/testing';\nexport const planted = publicFallbackSql;\n",
      () => sb.boundaries(['apps/api/src/planted.ts']),
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(
      /core-module-testing-in-tests-only: apps\/api\/src\/planted\.ts → packages\/core\/src\/modules\/search\/testing\.ts/,
    );
  });

  it("[S0-12] a planted import of another module's repo.ts fails check:boundaries", async () => {
    const result = await planted(
      `${MODULE_DIR}/planted.ts`,
      "import { findUserForEmail } from '../identity/repo';\nexport const planted = findUserForEmail;\n",
      () => sb.boundaries([MODULE_DIR]),
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/module-via-index-only: .*probe-listings\/planted\.ts → .*identity\/repo\.ts/);
  });

  it('[S0-12] a planted import of @inmolink/db/schema/<other> from a repo fails check:boundaries', async () => {
    const result = await planted(
      `${MODULE_DIR}/repo.ts`,
      "import { users } from '@inmolink/db/schema/identity';\nexport const planted = users;\n",
      () => sb.boundaries([MODULE_DIR]),
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(
      /module-own-schema-only: .*probe-listings\/repo\.ts → packages\/db\/src\/schema\/identity\.ts/,
    );
  });

  it('[S0-12] apps reach the database only through core and platform, and platform never imports core', async () => {
    const apps = await planted(
      'apps/api/src/planted.ts',
      "import Redis from 'ioredis';\nimport { withSystem } from '@inmolink/db';\nimport { register } from '../../../packages/core/src/modules/identity/service';\nexport const planted = [Redis, withSystem, register];\n",
      () => sb.boundaries(['apps/api/src/planted.ts']),
    );
    expect(apps.code).not.toBe(0);
    expect(apps.output).toMatch(/apps-thin-transports: apps\/api\/src\/planted\.ts → packages\/db\/src\/index\.ts/);
    expect(apps.output).toMatch(/core-public-api-only: apps\/api\/src\/planted\.ts → .*identity\/service\.ts/);
    expect(apps.output).toMatch(/apps-infra-via-platform: apps\/api\/src\/planted\.ts → .*node_modules\/ioredis\//);

    const platform = await planted(
      'packages/platform/src/planted.ts',
      "import { PACKAGE_NAME } from '../../core/src/index';\nexport const planted = PACKAGE_NAME;\n",
      () => sb.boundaries(['packages/platform/src/planted.ts']),
    );
    expect(platform.code).not.toBe(0);
    expect(platform.output).toMatch(
      /platform-never-imports-core: packages\/platform\/src\/planted\.ts → packages\/core\/src\/index\.ts/,
    );
  });
});
