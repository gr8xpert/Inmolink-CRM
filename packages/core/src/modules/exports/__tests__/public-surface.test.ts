import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S10-F1: the exports module's two entries (`index.ts`, the dashboard API's surface, and `worker.ts`, the worker-only
 * one) export nothing that no code outside the module uses — tests inside the module import internals directly — and
 * the worker-side helpers (`app_system`, a `tx` and no `ctx`) are in neither the index nor reachable from the API.
 */
const MODULE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(MODULE_DIR, '..', '..', '..', '..', '..');
const SCANNED = ['apps', 'packages', 'scripts', 'tests'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'generated']);
type Entry = 'index' | 'worker';
/**
 * The convention surface every module's index carries (PATTERNS §1, §6, §8): events are loaded through the module
 * (the outbox dispatcher, `MODULES` in apps/worker), errors and policy tables by convention.
 */
const CONVENTION = new Set([
  'exportsEvents',
  'exportsErrors',
  'CLIENT_MODE_ALLOWED',
  'EXPORTS_ACTIONS',
  'EXPORTS_IMPERSONATION',
]);

/** Names an entry file exports (`export { a, type B, c as d } from '...'`). */
function exportedNames(file: string): string[] {
  const text = readFileSync(join(MODULE_DIR, file), 'utf8');
  const names: string[] = [];
  for (const block of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const raw of (block[1] ?? '').split(',')) {
      const spec = raw
        .replace(/\/\/.*$/gm, '')
        .trim()
        .replace(/^type\s+/, '');
      if (!spec) continue;
      names.push(
        spec
          .split(/\s+as\s+/)
          .pop()
          ?.trim() as string,
      );
    }
  }
  return names;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && path !== MODULE_DIR.replace(/[\\/]$/, '')) sources(path, out);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Which entry an import specifier names: the package paths anywhere, or `../exports` (`../exports/worker`) from
 * another core module. Null: not an exports entry.
 */
function entryOf(specifier: string, file: string): Entry | null {
  if (specifier === '@inmolink/core/modules/exports') return 'index';
  if (specifier === '@inmolink/core/modules/exports/worker') return 'worker';
  if (!file.startsWith('packages/core/src/modules/')) return null;
  const m = /^(?:\.\.\/)+exports(\/index|\/worker)?$/.exec(specifier);
  if (!m) return null;
  return m[1] === '/worker' ? 'worker' : 'index';
}

/** Binding names of an import clause's braces: `a, type B, c as d` → a, B, c (the exported names). */
const namedSpecifiers = (braces: string) =>
  braces
    .split(',')
    .map((raw) =>
      raw
        .replace(/\/\/.*$/gm, '')
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+(?:as|:)\s+/)[0]
        ?.trim(),
    )
    .filter((n): n is string => !!n);

/**
 * The names each entry is imported by from outside the module, read from the import specifiers only: named imports
 * (`import { a } from`), namespace imports (`import * as ns from` → every `ns.<name>`) and destructured dynamic
 * imports (`const { a } = await import(...)`).
 */
function usedNames(): Record<Entry, Set<string>> {
  const used: Record<Entry, Set<string>> = { index: new Set(), worker: new Set() };
  for (const path of SCANNED.flatMap((d) => sources(join(ROOT, d)))) {
    const file = relative(ROOT, path).split(sep).join('/');
    if (file.startsWith('packages/core/src/modules/exports/')) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes('exports')) continue;
    const named = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    for (const [, braces = '', spec = ''] of text.matchAll(named)) {
      const entry = entryOf(spec, file);
      if (entry) for (const n of namedSpecifiers(braces)) used[entry].add(n);
    }
    const namespace = /import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
    for (const [, ns = '', spec = ''] of text.matchAll(namespace)) {
      const entry = entryOf(spec, file);
      if (!entry) continue;
      for (const [, n = ''] of text.matchAll(new RegExp(`\\b${ns}\\.(\\w+)`, 'g'))) used[entry].add(n);
    }
    const dynamic = /\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const [, braces = '', spec = ''] of text.matchAll(dynamic)) {
      const entry = entryOf(spec, file);
      if (entry) for (const n of namedSpecifiers(braces)) used[entry].add(n);
    }
  }
  return used;
}

describe('exports public surface', () => {
  const index = exportedNames('index.ts');
  const worker = exportedNames('worker.ts');

  it('[S10-F1] the worker-side helpers are not in the index (apps/api cannot reach them through it)', () => {
    expect(index.length).toBeGreaterThan(10);
    for (const name of [
      'decryptCredentials',
      'portalCredentialsCipher',
      'workerConnections',
      'connectionForWorker',
      'selectConnectionListings',
      'WorkerConnection',
    ]) {
      expect(index, name).not.toContain(name);
    }
  });

  it('[S10-F1] every export of index.ts and worker.ts is imported from that entry outside the module', () => {
    const used = usedNames();
    expect(used.index.size).toBeGreaterThan(5);
    const unused = [
      ...index.filter((n) => !CONVENTION.has(n) && !used.index.has(n)).map((n) => `index:${n}`),
      ...worker.filter((n) => !used.worker.has(n)).map((n) => `worker:${n}`),
    ];
    expect(unused).toEqual([]);
  });
});
