import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER, migrateEnv, runRls } from '@inmolink/db/migrate';
import { loadStackEnv } from '@inmolink/db/testing';
import { loadConfig } from '@inmolink/platform/config';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMigrations, journalProblems, migrationsAt, withDatabase } from '../../scripts/ci/migrations';

interface Journal {
  entries: { idx: number; tag: string; when: number; breakpoints: boolean; version: string }[];
}

const dirs: string[] = [];
function copyMigrations(edit: (folder: string, journal: Journal) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'inmolink-migtest-'));
  dirs.push(dir);
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const file = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(file, 'utf8')) as Journal;
  edit(dir, journal);
  writeFileSync(file, JSON.stringify(journal, null, 2));
  return dir;
}

let cfg: ReturnType<typeof loadConfig<typeof migrateEnv>>;

describe('migration check', () => {
  beforeAll(() => {
    loadStackEnv('test');
    cfg = loadConfig(migrateEnv);
  });
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('[S0-14] applies every migration to an empty database with a clean RLS guard', async () => {
    const [journal, empty] = await checkMigrations(cfg, { prefix: 'migtest_a' });
    expect(journal?.problems).toEqual([]);
    expect(empty?.name).toBe('empty database');
    expect(empty?.steps).toHaveLength(2); // applied, then re-applied as a no-op
    expect(empty?.problems).toEqual([]);
  });

  it("[S0-14] applies the current migrations over the previous release's schema", async () => {
    // "Previous release" = every migration but the newest one.
    const previous = copyMigrations((dir, journal) => {
      const last = journal.entries.pop();
      if (last) rmSync(join(dir, `${last.tag}.sql`));
    });
    const scenarios = await checkMigrations(cfg, {
      prefix: 'migtest_b',
      previous: { ref: 'fixture', folder: previous },
    });
    expect(scenarios.map((s) => s.name)).toEqual(['migration journal', 'empty database', 'upgrade from fixture']);
    expect(scenarios.flatMap((s) => s.problems)).toEqual([]);
    expect(scenarios[2]?.steps).toEqual([
      'migrations at fixture',
      'current migrations',
      'current migrations again (no-op)',
    ]);
  });

  const withoutNewest = (dir: string, j: Journal) => {
    const last = j.entries.pop();
    if (last) rmSync(join(dir, `${last.tag}.sql`));
  };

  it('[S0-14] fails when a released migration was edited', () => {
    const previous = copyMigrations((dir, j) => {
      withoutNewest(dir, j);
      const first = j.entries[0] as Journal['entries'][number];
      writeFileSync(join(dir, `${first.tag}.sql`), `${readFileSync(join(dir, `${first.tag}.sql`), 'utf8')}\n-- edited`);
    });
    expect(journalProblems(previous, MIGRATIONS_FOLDER)).toEqual([
      expect.stringMatching(/released migration was edited/),
    ]);
  });

  it('[S0-14] fails when a released migration was removed or renamed', () => {
    const previous = copyMigrations((dir, j) => {
      withoutNewest(dir, j);
      j.entries.push({ ...(j.entries.at(-1) as Journal['entries'][number]), tag: '0099_gone', when: Date.now() });
      writeFileSync(join(dir, '0099_gone.sql'), 'select 1;');
    });
    expect(journalProblems(previous, MIGRATIONS_FOLDER)).toEqual([
      expect.stringMatching(/^0099_gone: released migration was removed, renamed or reordered/),
    ]);
  });

  it('[S0-14] fails when a new migration is ordered before released ones (drizzle would skip it)', () => {
    const current = copyMigrations((_dir, j) => {
      const last = j.entries.at(-1) as Journal['entries'][number];
      last.when = (j.entries[0] as Journal['entries'][number]).when - 1;
    });
    expect(journalProblems(undefined, current)).toEqual([expect.stringMatching(/created before/)]);
  });

  it('[S0-14] fails on a migration that does not apply', async () => {
    const broken = copyMigrations((dir, journal) => {
      const last = journal.entries.at(-1);
      if (!last) throw new Error('no migrations');
      const tag = '9999_broken';
      journal.entries.push({ ...last, idx: last.idx + 1, tag, when: last.when + 1 });
      writeFileSync(join(dir, `${tag}.sql`), 'alter table no_such_table add column x int;');
    });
    await expect(checkMigrations(cfg, { prefix: 'migtest_c', folder: broken })).rejects.toThrow(/no_such_table/);
  });

  it('[S0-14] reads the migrations of an earlier commit from git history', () => {
    const at = migrationsAt('HEAD');
    expect(at).toBeDefined();
    try {
      const journal = JSON.parse(readFileSync(join(at?.folder as string, 'meta', '_journal.json'), 'utf8')) as Journal;
      expect(journal.entries.length).toBeGreaterThan(0);
    } finally {
      at?.cleanup();
    }
    expect(migrationsAt('no-such-ref-xyz')).toBeUndefined();
  });

  it('[S0-14] test setup skips the RLS DDL when the database already matches the registry', async () => {
    const lines: string[] = [];
    const log = { info: (a: unknown, b?: unknown) => lines.push(String(typeof a === 'string' ? a : b)) };
    await runRls(cfg, log); // brings the test database up to date
    lines.length = 0;
    expect(await runRls(cfg, log, undefined, { ifStale: true })).toEqual([]);
    expect(lines).toEqual(['rls current: skipped apply']);
  });

  it('[S0-14] test setup re-applies RLS when the generated SQL changed since the last apply', async () => {
    const lines: string[] = [];
    const log = { info: (a: unknown, b?: unknown) => lines.push(String(typeof a === 'string' ? a : b)) };
    await runRls(cfg, log);
    // A predicate or helper-body change alters the generated SQL, not anything the guard compares.
    const owner = new pg.Client({ connectionString: cfg.DATABASE_URL_APP_OWNER });
    await owner.connect();
    try {
      await owner.query(`comment on function public.app_agency() is 'rls sha256:stale'`);
    } finally {
      await owner.end();
    }
    lines.length = 0;
    expect(await runRls(cfg, log, undefined, { ifStale: true })).toEqual([]);
    expect(lines).toEqual(['rls applied']);
    lines.length = 0;
    await runRls(cfg, log, undefined, { ifStale: true });
    expect(lines).toEqual(['rls current: skipped apply']); // stamped again
  });

  it('[S0-14] points every database URL at the throwaway database', () => {
    const scoped = withDatabase(cfg, 'migtest_x');
    expect(new URL(scoped.DATABASE_URL_APP_OWNER).pathname).toBe('/migtest_x');
    expect(new URL(scoped.DATABASE_URL_APP_USER).pathname).toBe('/migtest_x');
    expect(new URL(scoped.DATABASE_URL_APP_OWNER).username).toBe(new URL(cfg.DATABASE_URL_APP_OWNER).username);
  });
});
