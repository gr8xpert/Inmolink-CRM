import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from '@inmolink/platform/config';
import pg from 'pg';
import { configureDb, dbEnv } from '../src/client';
import { loadStackEnv } from '../src/env-file';
import { migrateEnv, runMigrations, runRls } from '../src/migrate';

export { loadStackEnv } from '../src/env-file';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const silent = { info: () => {} };

async function reachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Integration setup: the docker `test` stack (started only if Postgres is unreachable, so parallel
 * packages do not race on `compose up`), roles + migrations + RLS/grants (production registry), and
 * pools configured from `.env.test`. Guard problems are left to `pnpm test:isolation`: it plants
 * fixture tables that this registry does not know.
 */
export async function setupTestDb(appRole: 'http' | 'worker' | 'script' = 'http') {
  loadStackEnv('test');
  const cfg = loadConfig(migrateEnv);
  if (!cfg.DATABASE_URL_ADMIN || !(await reachable(cfg.DATABASE_URL_ADMIN))) {
    execFileSync('docker', ['compose', '--profile', 'test', 'up', '-d', '--wait'], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 300_000,
    });
  }
  await runMigrations(cfg, silent);
  await runRls(cfg, silent, undefined, { ifStale: true });
  const db = loadConfig(dbEnv);
  await configureDb({ ...db, APP_ROLE: appRole });
  return cfg;
}

/**
 * A staff user (S1-03): a confirmed `users` row without an agency plus its `staff_users` role, written
 * through the admin connection (staff are granted by a script, never by a request role), so it works
 * in `http` tests too. The password hash is not usable: tests mint access tokens directly.
 */
export async function createStaffUser(
  role: 'SUPER_ADMIN' | 'STAFF_SUPPORT' | 'STAFF_DATA_OPS' = 'STAFF_SUPPORT',
): Promise<{ userId: string; email: string }> {
  loadStackEnv('test');
  const cfg = loadConfig(migrateEnv);
  if (!cfg.DATABASE_URL_ADMIN) throw new Error('createStaffUser needs DATABASE_URL_ADMIN');
  const admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    const userId = crypto.randomUUID();
    const email = `staff-${userId.slice(0, 8)}@staff.inmolink.test`;
    await admin.query(
      `insert into users (id, email, password_hash, name, locale, email_verified_at)
       values ($1, $2, 'not-a-hash', 'Staff', 'en', now())`,
      [userId, email],
    );
    await admin.query('insert into staff_users (user_id, role) values ($1, $2)', [userId, role]);
    return { userId, email };
  } finally {
    await admin.end();
  }
}

/**
 * Sets an agency's status through the admin connection (S1-05): staff decide it in production, but app
 * tests (`http`, no `withSystem`) need a verified agency without driving the staff flow.
 */
export async function setAgencyStatus(agencyId: string, status: 'PENDING' | 'VERIFIED' | 'SUSPENDED'): Promise<void> {
  loadStackEnv('test');
  const cfg = loadConfig(migrateEnv);
  if (!cfg.DATABASE_URL_ADMIN) throw new Error('setAgencyStatus needs DATABASE_URL_ADMIN');
  const admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    await admin.query(
      'update agencies set status = $2, onboarded_at = coalesce(onboarded_at, now()) where agency_id = $1',
      [agencyId, status],
    );
  } finally {
    await admin.end();
  }
}

export type AdminQuery = <R extends Record<string, unknown>>(text: string, values?: unknown[]) => Promise<R[]>;

/**
 * One superuser connection in a transaction that is always rolled back (S2-F1): for query-plan tests that
 * seed volume, `ANALYZE` it (app roles hold no MAINTAIN) and EXPLAIN as an app role (`set local role`).
 * Nothing stays behind but dead tuples; the statistics are re-analysed after the rollback, since
 * `pg_class.reltuples` is updated in place and would otherwise keep the seeded row counts.
 */
export async function withAdminRollback<T>(tables: readonly string[], fn: (q: AdminQuery) => Promise<T>): Promise<T> {
  loadStackEnv('test');
  const cfg = loadConfig(migrateEnv);
  if (!cfg.DATABASE_URL_ADMIN) throw new Error('withAdminRollback needs DATABASE_URL_ADMIN');
  const admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
  const q: AdminQuery = async (text, values = []) => (await admin.query(text, values)).rows;
  try {
    await admin.query('begin');
    try {
      return await fn(q);
    } finally {
      await admin.query('rollback');
      for (const t of tables) await admin.query(`analyze ${pg.escapeIdentifier(t)}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Runs SQL as the bootstrap superuser (S1-08): for tests that change what no app role may change, such
 * as dropping a partition to prove the maintenance job creates it again. Returns the rows.
 */
export async function adminQuery<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  loadStackEnv('test');
  const cfg = loadConfig(migrateEnv);
  if (!cfg.DATABASE_URL_ADMIN) throw new Error('adminQuery needs DATABASE_URL_ADMIN');
  const admin = new pg.Client({ connectionString: cfg.DATABASE_URL_ADMIN });
  await admin.connect();
  try {
    return (await admin.query<R>(text, values)).rows;
  } finally {
    await admin.end();
  }
}
