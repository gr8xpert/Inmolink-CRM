import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface PackageJson {
  name: string;
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function workspacePackages(): { dir: string; pkg: PackageJson }[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'wp-plugin')
      .map((d) => {
        const dir = join(ROOT, group, d.name);
        return { dir, pkg: readJson<PackageJson>(join(dir, 'package.json')) };
      }),
  );
}

const rootPkg = readJson<PackageJson>(join(ROOT, 'package.json'));

describe('workspace scaffold', () => {
  it('[S0-01] has every app and package from PLAN §5.7', () => {
    const names = workspacePackages().map((p) => p.pkg.name);
    for (const app of ['api', 'feed-api', 'realtime', 'worker', 'web', 'public']) {
      expect(names).toContain(`@inmolink/app-${app}`);
    }
    for (const pkg of ['core', 'db', 'contracts', 'platform', 'i18n', 'ui', 'sdk', 'config']) {
      expect(names).toContain(`@inmolink/${pkg}`);
    }
  });

  it('[S0-01] every package exports a placeholder and builds independently', () => {
    for (const { pkg } of workspacePackages()) {
      if (pkg.name === '@inmolink/config') continue; // presets only — nothing to compile
      expect(pkg.scripts, pkg.name).toMatchObject({
        build: expect.any(String),
        typecheck: expect.any(String),
        lint: expect.any(String),
        test: expect.any(String),
        'test:int': expect.any(String),
      });
      if (pkg.name.startsWith('@inmolink/app-')) continue;
      expect(pkg.exports?.['.'], pkg.name).toMatchObject({ '@inmolink/source': './src/index.ts' });
    }
  });

  it('[S0-01] root defines every command listed in CLAUDE.md', () => {
    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    const section = claude.slice(claude.indexOf('## Commands'), claude.indexOf('## Architecture'));
    const commands = [...section.matchAll(/`pnpm ([a-z0-9:]+)/g)].map((m) => m[1] ?? '');
    expect(commands.length).toBeGreaterThan(10);
    for (const command of commands) {
      expect(rootPkg.scripts, command).toHaveProperty([command]);
    }
  });

  it('[S0-01] verify runs only affected packages through Turbo', () => {
    const verify = rootPkg.scripts?.verify ?? '';
    expect(verify).toMatch(/^turbo run /);
    expect(verify).toContain('--affected');
    for (const task of ['typecheck', 'lint', 'test', 'test:int']) {
      expect(verify.split(' ')).toContain(task);
    }
  });
});
