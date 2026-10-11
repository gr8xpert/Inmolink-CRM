/**
 * `pnpm gen:module <name> [--no-routes]` (S0-12) — scaffolds a domain module in the PATTERNS §1 layout:
 * core module files + policy test, `db/schema/<name>.ts`, `contracts/<name>.ts` (both re-exported from
 * their barrels) and, unless `--no-routes`, an api route plugin registered in `apps/api/src/app.ts`.
 * Refuses to overwrite anything. Generated files are formatted with Biome.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barrelEdits, type ModuleNames, moduleFiles, moduleNames } from './module-templates';

const API_APP = 'apps/api/src/app.ts';
const WORKER_MODULES = 'apps/worker/src/subscriptions.ts';
const NL = '\n';

export interface GenerateOptions {
  routes: boolean;
}

/**
 * Writes the module under `root` and returns the repo-relative paths it created or changed. Every edit
 * is computed (and every anchor checked) before the first write, so a failure leaves nothing behind.
 */
export function generateModule(root: string, name: string, opts: GenerateOptions): string[] {
  const n = moduleNames(name);
  const files = moduleFiles(n, opts);
  if (existsSync(resolve(root, 'packages/core/src/modules', n.kebab))) {
    throw new Error(`Module "${n.kebab}" already exists in packages/core/src/modules.`);
  }
  const taken = Object.keys(files).filter((p) => existsSync(resolve(root, p)));
  if (taken.length > 0) throw new Error(`Refusing to overwrite: ${taken.join(', ')}`);

  const edits: Record<string, string> = {};
  for (const edit of barrelEdits(n)) {
    const updated = withReExport(readFileSync(resolve(root, edit.path), 'utf8'), edit.line);
    if (updated !== null) edits[edit.path] = updated;
  }
  if (opts.routes) edits[API_APP] = withRoutes(readFileSync(resolve(root, API_APP), 'utf8'), n);
  edits[WORKER_MODULES] = withWorkerModule(readFileSync(resolve(root, WORKER_MODULES), 'utf8'), n);

  for (const [path, content] of Object.entries({ ...files, ...edits })) {
    const abs = resolve(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return [...Object.keys(files), ...Object.keys(edits)];
}

/** Adds `export * from './x';` in alphabetical order among the barrel's re-exports; null if present. */
function withReExport(source: string, line: string): string | null {
  const lines = source.split(NL);
  if (lines.includes(line)) return null;
  const reExports = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith("export * from './"));
  const after = reExports.find(({ l }) => l > line);
  const at = after ? after.i : (reExports.at(-1)?.i ?? lines.length - 1) + 1;
  lines.splice(at, 0, line);
  return lines.join(NL);
}

/** Imports the route plugin and registers it after the last `await app.register(<x>Routes);`. */
function withRoutes(source: string, n: ModuleNames): string {
  const lines = source.split(NL);
  const lastRegister = lines.findLastIndex((l) => /^\s*await app\.register\(\w+Routes\);$/.test(l));
  if (lastRegister < 0) throw new Error(`${API_APP}: no "await app.register(<x>Routes);" line to follow.`);
  // End of the last import statement: Biome may wrap an import over several lines.
  const lastImportEnd = lines.findLastIndex((l, i) => i < lastRegister && /\bfrom '[^']+';$/.test(l));
  if (lastImportEnd < 0) throw new Error(`${API_APP}: no import statement found.`);
  const indent = /^\s*/.exec(lines[lastRegister] ?? '')?.[0] ?? '  ';
  lines.splice(lastRegister + 1, 0, `${indent}await app.register(${n.camel}Routes);`);
  lines.splice(lastImportEnd + 1, 0, `import { ${n.camel}Routes } from './routes/${n.kebab}/routes';`);
  return lines.join(NL);
}

/**
 * Adds the module to the worker's `MODULES`, so its events.ts loads in the dispatcher process (an event
 * type the dispatcher does not know is retried, never marked processed).
 */
function withWorkerModule(source: string, n: ModuleNames): string {
  const open = 'export const MODULES = {';
  const start = source.indexOf(open);
  const end = start < 0 ? -1 : source.indexOf('} as const;', start);
  if (end < 0) throw new Error(`${WORKER_MODULES}: no "export const MODULES = { … } as const;" to extend.`);
  const entries = source
    .slice(start + open.length, end)
    .trim()
    .replace(/,$/, '');
  const entry = n.kebab === n.camel ? n.camel : `'${n.kebab}': ${n.camel}`;
  const lines = `${source.slice(0, start)}${open} ${entries ? `${entries}, ` : ''}${entry} ${source.slice(end)}`.split(
    NL,
  );
  const lastImportEnd = lines.findLastIndex((l) => /\bfrom '[^']+';$/.test(l));
  lines.splice(lastImportEnd + 1, 0, `import * as ${n.camel} from '@inmolink/core/modules/${n.kebab}';`);
  return lines.join(NL);
}

/** `biome check --write` on the given files (import order, formatting), from `root`. */
export function formatFiles(root: string, paths: string[]): void {
  const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
  const result = spawnSync(process.execPath, [biome, 'check', '--write', '--files-ignore-unknown=true', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`biome check failed:\n${result.stdout}${result.stderr}`);
}

function main(argv: string[]): void {
  const args = argv.filter((a) => !a.startsWith('--'));
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--no-routes');
  if (args.length !== 1 || unknown.length > 0) {
    console.error('Usage: pnpm gen:module <kebab-name> [--no-routes]');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const touched = generateModule(root, args[0] as string, { routes: !argv.includes('--no-routes') });
  formatFiles(root, touched);
  const n = moduleNames(args[0] as string);
  console.log(`Created module ${n.kebab}:\n${touched.map((p) => `  ${p}`).join('\n')}`);
  console.log(
    [
      '',
      'Next: tables in the schema file + tenancy registry (pnpm db:generate && pnpm db:migrate && pnpm db:rls),',
      'DTOs in contracts, use cases in service.ts exported from index.ts, then pnpm check:boundaries && pnpm typecheck.',
    ].join('\n'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
