import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER, type MigrateConfig, runMigrations, runRls } from '@inmolink/db/migrate';
import pg from 'pg';

const ROOT = join(import.meta.dirname, '..', '..');
const EXTENSIONS_SQL = join(ROOT, 'infra', 'docker', 'postgres', 'initdb', '01-extensions.sql');
const MIGRATIONS_PATH = 'packages/db/migrations';

export type Log = { info: (msg: string) => void };
export type Scenario = { name: string; steps: string[]; problems: string[] };

/** Every DATABASE_URL_* pointed at `database`; roles and hosts stay as configured. */
export function withDatabase(cfg: MigrateConfig, database: string): MigrateConfig {
  const out: Record<string, unknown> = { ...cfg };
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('DATABASE_URL_') || typeof value !== 'string') continue;
    const url = new URL(value);
    url.pathname = `/${database}`;
    out[key] = url.toString();
  }
  return out as MigrateConfig;
}

async function admin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * A throwaway database shaped like a fresh server: created by the admin role with the extensions
 * from the Postgres image's initdb script (they are per database, so a new one starts without them).
 */
async function freshDatabase(cfg: MigrateConfig, database: string): Promise<MigrateConfig> {
  const adminUrl = cfg.DATABASE_URL_ADMIN;
  if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is required for the migration check');
  const ident = pg.escapeIdentifier(database);
  await admin(adminUrl, async (c) => {
    await c.query(`drop database if exists ${ident} with (force)`);
    await c.query(`create database ${ident}`);
  });
  const scoped = withDatabase(cfg, database);
  await admin(scoped.DATABASE_URL_ADMIN as string, (c) => c.query(readFileSync(EXTENSIONS_SQL, 'utf8')));
  return scoped;
}

async function dropDatabase(cfg: MigrateConfig, database: string): Promise<void> {
  await admin(cfg.DATABASE_URL_ADMIN as string, (c) =>
    c.query(`drop database if exists ${pg.escapeIdentifier(database)} with (force)`),
  );
}

/** `packages/db/migrations` as of a git ref, extracted to a temp folder; undefined if the ref has none. */
export function migrationsAt(ref: string): { folder: string; cleanup: () => void } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'inmolink-migrations-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const tar = join(dir, 'migrations.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', tar, ref, '--', MIGRATIONS_PATH], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    execFileSync('tar', ['-xf', 'migrations.tar'], { cwd: dir, stdio: 'pipe' });
  } catch {
    cleanup();
    return undefined; // the ref predates the migrations folder
  }
  const folder = join(dir, ...MIGRATIONS_PATH.split('/'));
  if (!existsSync(join(folder, 'meta', '_journal.json'))) {
    cleanup();
    return undefined;
  }
  return { folder, cleanup };
}

/**
 * The schema production runs: the newest `v*` tag; else, on a branch, where it forked from main;
 * else (on main itself) the previous commit.
 */
export function previousReleaseRef(base = 'origin/main'): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }).trim();
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD');
  } catch {}
  try {
    const fork = git('merge-base', 'HEAD', base);
    if (fork !== git('rev-parse', 'HEAD')) return fork;
  } catch {}
  return 'HEAD~1';
}

interface JournalEntry {
  tag: string;
  when: number;
}
const journal = (folder: string): JournalEntry[] =>
  (JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;

/**
 * Drizzle applies a migration only if its `when` is newer than the last applied one and never
 * re-checks applied files, so these slip past a migrate run: an edited released migration, a
 * removed or renamed one, and one ordered before migrations already released (skipped forever).
 */
export function journalProblems(previousFolder: string | undefined, folder: string): string[] {
  const problems: string[] = [];
  const current = journal(folder);
  current.forEach((e, i) => {
    const before = current[i - 1];
    if (before && e.when <= before.when) problems.push(`${e.tag}: created before ${before.tag} (regenerate it)`);
  });
  if (!previousFolder) return problems;
  journal(previousFolder).forEach((p, i) => {
    const c = current[i];
    if (!c || c.tag !== p.tag || c.when !== p.when) {
      problems.push(`${p.tag}: released migration was removed, renamed or reordered`);
      return;
    }
    // Line endings normalised: a Windows checkout with autocrlf is not an edit.
    const sql = (dir: string) => readFileSync(join(dir, `${p.tag}.sql`), 'utf8').replace(/\r\n/g, '\n');
    if (sql(previousFolder) !== sql(folder)) problems.push(`${p.tag}: released migration was edited (add a new one)`);
  });
  return problems;
}

async function migrateAndGuard(cfg: MigrateConfig, folder: string, steps: string[], label: string): Promise<string[]> {
  const silent = { info: () => {} };
  await runMigrations(cfg, silent, folder);
  steps.push(label);
  return runRls(cfg, silent);
}

/**
 * CI migration check (S0-14, PLAN §18): (1) every migration applies to an empty database and the
 * RLS guard is clean; (2) the current migrations apply on top of the previous release's schema,
 * exactly as a deploy would run them, and the guard is clean; both re-run as no-ops. Before both,
 * the journal must extend the previous release's unchanged (`journalProblems`).
 */
export async function checkMigrations(
  cfg: MigrateConfig,
  opts: { previous?: { ref: string; folder: string }; folder?: string; prefix?: string; log?: Log } = {},
): Promise<Scenario[]> {
  const folder = opts.folder ?? MIGRATIONS_FOLDER;
  // Unique per run: two checks on one Postgres must not drop each other's databases.
  const prefix = opts.prefix ?? `inmolink_migcheck_${process.pid}`;
  const log = opts.log ?? { info: () => {} };
  const scenarios: Scenario[] = [
    { name: 'migration journal', steps: ['journal'], problems: journalProblems(opts.previous?.folder, folder) },
  ];

  const run = async (
    name: string,
    database: string,
    plan: (db: MigrateConfig, steps: string[]) => Promise<string[]>,
  ) => {
    log.info(`migration check: ${name}`);
    const db = await freshDatabase(cfg, database);
    const steps: string[] = [];
    try {
      scenarios.push({ name, steps, problems: await plan(db, steps) });
    } finally {
      await dropDatabase(cfg, database);
    }
  };

  await run('empty database', `${prefix}_empty`, async (db, steps) => {
    await migrateAndGuard(db, folder, steps, 'current migrations');
    return migrateAndGuard(db, folder, steps, 'current migrations again (no-op)');
  });

  const previous = opts.previous;
  if (previous) {
    await run(`upgrade from ${previous.ref}`, `${prefix}_upgrade`, async (db, steps) => {
      // Migrations only: the current registry may name tables the previous release did not have.
      await runMigrations(db, { info: () => {} }, previous.folder);
      steps.push(`migrations at ${previous.ref}`);
      await migrateAndGuard(db, folder, steps, 'current migrations');
      return migrateAndGuard(db, folder, steps, 'current migrations again (no-op)');
    });
  }
  return scenarios;
}
