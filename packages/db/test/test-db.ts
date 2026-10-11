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
