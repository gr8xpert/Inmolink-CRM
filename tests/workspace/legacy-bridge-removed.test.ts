import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * S17-F4 (decision 2026-11-01): the old Inmolink system never runs beside v2. The legacy `/v1` shim and its flag, the
 * golden-file harness, the live legacy delta (hourly job, legacy database adapter and URL) and the WordPress plugin's
 * legacy settings migration are gone — nothing in the repository may refer to them again.
 */
const ROOT = join(import.meta.dirname, '..', '..');

/** Split so this file does not name them itself. */
const REMOVED = [
  ['LEGACY_DATABASE', '_URL'],
  ['LEGACY_DB_STATEMENT', '_TIMEOUT_MS'],
  ['LEGACY_DB_MAX', '_CONNECTIONS'],
  ['LEGACY_V1_HIDE', '_NETWORK_OWNER'],
  ['INMOLINK_MIGRATE', '_LEGACY_SETTINGS'],
  ['legacy:', 'traffic'],
  ['legacy:', 'record'],
  ['legacy:', 'scan'],
  ['legacy:', 'key-flag'],
  ['test:', 'golden'],
  ['scheduleLegacy', 'Deltas'],
  // The retired hourly job's name (the delta engine `syncLegacyDelta` itself stays: `legacy:delta`, `FINAL_DELTA`).
  ["'migration.sync", "LegacyDelta'"],
  ['legacy', '-db'],
  ['legacy_query', '_key'],
  ['legacyQuery', 'Key'],
  ['dns', '-check'],
].map((parts) => parts.join(''));

const QUERY_KEY_COLUMN = ['legacy_query', '_key'].join('');
// S17-F4: the worker removes the retired hourly job's BullMQ scheduler from a deployed Redis by this name.
const RETIRED_SCHEDULER = ['scheduleLegacy', 'Deltas'].join('');

/** Tests that assert a removed name is gone may name it (S17-F4 only). */
const ALLOWED: Record<string, readonly string[]> = {
  'packages/db/src/tenancy/rls.test.ts': [QUERY_KEY_COLUMN],
  'tests/isolation/generated.int.test.ts': [QUERY_KEY_COLUMN],
  'tests/ci/migration-backfill.int.test.ts': [QUERY_KEY_COLUMN],
  // The deploy step that lists the keys 0181 revokes.
  'docs/runbooks/cutover.md': [QUERY_KEY_COLUMN],
  'apps/worker/src/processors/index.ts': [RETIRED_SCHEDULER],
  'apps/worker/src/processors/pools.test.ts': [RETIRED_SCHEDULER],
  'packages/core/src/modules/migration/__tests__/delta.int.test.ts': [RETIRED_SCHEDULER],
};

/** History that may keep the old names: build log, changelog, backlog, sprint reviews, applied migrations. */
const EXCLUDED = [
  /^docs\/build\/STATUS\.md$/,
  /^CHANGELOG\.md$/,
  /^docs\/build\/BACKLOG[^/]*\.md$/,
  /^docs\/build\/reviews\//,
  /^packages\/db\/migrations\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.turbo\//,
  /^graphify-out\//,
];

/** New (untracked) files count only inside the repository's source trees: local scratch files never fail the scan. */
const SOURCE_DIRS = /^(apps|packages|scripts|tests|docs|infra|\.github|\.claude)\//;

const git = (args: string[]) =>
  execFileSync('git', ['ls-files', ...args, '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((f) => f !== '');

/** Tracked files, plus new not-ignored files in the source trees, that exist in the working tree. */
function repoFiles(): string[] {
  const files = new Set([
    ...git(['--cached']),
    ...git(['--others', '--exclude-standard']).filter((f) => SOURCE_DIRS.test(f)),
  ]);
  return [...files]
    .filter((f) => !EXCLUDED.some((re) => re.test(f)))
    .filter((f) => {
      const path = join(ROOT, f);
      return existsSync(path) && statSync(path).isFile();
    })
    .sort();
}

describe('legacy bridge removed (S17-F4)', () => {
  it('[S17-F4] nothing references the removed env vars, scripts, flags, jobs or the legacy database adapter', () => {
    const hits: string[] = [];
    for (const file of repoFiles()) {
      const buf = readFileSync(join(ROOT, file));
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const allowed = ALLOWED[file] ?? [];
      const lines = buf.toString('utf8').split('\n');
      lines.forEach((line, i) => {
        for (const term of REMOVED) {
          if (line.includes(term) && !allowed.includes(term)) hits.push(`${file}:${i + 1}: ${term}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('[S17-F4] the removed scripts, harness and plugin migration are gone from package.json and the tree', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const name of REMOVED.filter((t) => /^(legacy|test):/.test(t))) {
      expect(pkg.scripts[name], name).toBeUndefined();
    }
    // The one-time import stays (S2-06, S4-04, S14).
    for (const name of ['legacy:extract', 'legacy:taxonomy', 'legacy:load', 'legacy:validate']) {
      expect(pkg.scripts[name], name).toBeDefined();
    }
    for (const path of [
      'tests/golden',
      'scripts/legacy-api',
      'apps/feed-api/src/routes/legacy-v1',
      'packages/contracts/src/legacy-v1.ts',
      'packages/core/src/modules/website-api/legacy-v1.ts',
      'apps/wp-plugin/src/Migration',
      'apps/wp-plugin/tests/Integration/LegacyMigrationTest.php',
      'apps/wp-plugin/tests/fixtures/legacy',
    ]) {
      expect(existsSync(join(ROOT, path)), path).toBe(false);
    }
  });
});
