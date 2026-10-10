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
