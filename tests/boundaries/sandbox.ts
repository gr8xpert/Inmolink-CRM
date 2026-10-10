/**
 * Throwaway copy of the workspace for the boundary tests (S0-12): generated modules and planted
 * violations go here, never into the real tree that parallel `verify` tasks are typechecking.
 *
 * Copies the tracked and untracked-but-not-ignored sources, then rebuilds every `node_modules` as
 * junctions: workspace packages point at the sandbox copy, third-party packages at their real
 * location in the repo's pnpm store. Nothing is installed.
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SOURCE_DIRS = ['packages', 'apps', 'scripts'];
const ROOT_FILES = ['.dependency-cruiser.cjs', '.gitignore', 'biome.json', 'package.json', 'tsconfig.json'];

export interface CommandResult {
  code: number;
  output: string;
}

export interface Sandbox {
  root: string;
  /** Runs a Node CLI script with the sandbox as working directory. Never throws on a non-zero exit. */
  node(script: string, args: string[]): Promise<CommandResult>;
  typecheck(projectDir: string): Promise<CommandResult>;
  biome(paths: string[]): Promise<CommandResult>;
  boundaries(paths?: string[]): Promise<CommandResult>;
  cleanup(): void;
}

const PREFIX = 'inmolink-boundaries-';

/**
 * Deletes a sandbox: unlinks every junction first, so a recursive delete can never reach into the
 * repo's node_modules, then removes the rest.
 */
function removeSandbox(root: string): void {
  const unlinkLinks = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
      else if (entry.isDirectory()) unlinkLinks(path);
    }
  };
  if (!existsSync(root)) return;
  unlinkLinks(root);
  rmSync(root, { recursive: true, force: true });
}

/** Copies the sources and rebuilds every node_modules as junctions (see the file comment). */
function populate(root: string): void {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...SOURCE_DIRS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.startsWith('apps/wp-plugin/') && existsSync(join(REPO_ROOT, f)));
  for (const file of [...files, ...ROOT_FILES]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPO_ROOT, file), join(root, file));
  }

  const link = (target: string, path: string): void => symlinkSync(target, path, 'junction');
  const toSandbox = (real: string): string => {
    const rel = relative(REPO_ROOT, real);
    const inWorkspace = !rel.startsWith('..') && SOURCE_DIRS.some((d) => rel.startsWith(`${d}${sep}`));
    return inWorkspace ? join(root, rel) : real;
  };
  const workspaceDirs = [
    '.',
    ...['packages', 'apps'].flatMap((d) => readdirSync(join(REPO_ROOT, d)).map((p) => `${d}/${p}`)),
  ];
  for (const dir of workspaceDirs) {
    const from = join(REPO_ROOT, dir, 'node_modules');
    if (!existsSync(from) || !existsSync(join(root, dir))) continue;
    for (const entry of readdirSync(from)) {
      if (entry.startsWith('.')) continue;
      const names = entry.startsWith('@') ? readdirSync(join(from, entry)).map((n) => `${entry}/${n}`) : [entry];
      for (const name of names) {
        const path = join(root, dir, 'node_modules', name);
        mkdirSync(dirname(path), { recursive: true });
        link(toSandbox(realpathSync(join(from, name))), path);
      }
    }
  }
  // Biome reads .gitignore through git (`vcs.useIgnoreFile`).
  execFileSync('git', ['init', '-q'], { cwd: root });
}

export function createSandbox(): Sandbox {
  // Leftovers of interrupted runs (Ctrl-C, killed worker); an hour old, so a concurrent run keeps its own.
  for (const stale of readdirSync(tmpdir()).filter((d) => d.startsWith(PREFIX))) {
    const path = join(tmpdir(), stale);
    if (Date.now() - statSync(path).mtimeMs > 3_600_000) removeSandbox(path);
  }
  const root = mkdtempSync(join(tmpdir(), PREFIX));
  try {
    populate(root);
  } catch (error) {
    removeSandbox(root);
    throw error;
  }

  const node = async (script: string, args: string[]): Promise<CommandResult> => {
    try {
      const { stdout, stderr } = await run(process.execPath, [script, ...args], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  return {
    root,
    node,
    typecheck: (projectDir) =>
      node(require.resolve('typescript/bin/tsc'), ['--noEmit', '-p', join(root, projectDir, 'tsconfig.json')]),
    biome: (paths) =>
      node(require.resolve('@biomejs/biome/bin/biome'), ['check', '--files-ignore-unknown=true', ...paths]),
    boundaries: (paths = []) => node(require.resolve('tsx/cli'), ['scripts/boundaries/check.ts', ...paths]),
    cleanup: () => removeSandbox(root),
  };
}
