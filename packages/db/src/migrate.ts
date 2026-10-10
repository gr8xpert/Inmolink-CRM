import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, databaseAdminEnv, databaseEnv, databaseOwnerEnv } from '@inmolink/platform/config';
import type { Logger } from '@inmolink/platform/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { bootstrapRoles, credentialFromUrl } from './bootstrap';
import { checkRls } from './tenancy/guard';
import { registry, type TenantRegistry } from './tenancy/registry';
import { applyRls, generateRlsSql } from './tenancy/rls';

export const migrateEnv = { ...databaseEnv, ...databaseOwnerEnv, ...databaseAdminEnv };
export type MigrateConfig = Config<typeof migrateEnv>;

export const MIGRATIONS_FOLDER = join(import.meta.dirname, '..', 'migrations');

/** Session advisory lock: concurrent deploys or test workers migrate one at a time. */
const MIGRATION_LOCK = 4_120_250_404;

/** Waits at most 60 s for another migrator instead of hanging a deploy forever. */
async function lock(client: pg.ClientBase): Promise<void> {
  await client.query(`set lock_timeout = '60s'`);
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
  } catch (err) {
    throw new Error('another db:migrate holds the migration lock (waited 60 s)', { cause: err });
  }
  await client.query('reset lock_timeout');
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

/**
 * `pnpm db:migrate`: (1) with DATABASE_URL_ADMIN, create/update roles and grants; (2) apply
 * pending drizzle-kit migrations as `app_owner` over a direct (non-PgBouncer) connection.
 */
export async function runMigrations(
  cfg: MigrateConfig,
  log: Pick<Logger, 'info'>,
  folder = MIGRATIONS_FOLDER,
): Promise<void> {
  const admin = cfg.DATABASE_URL_ADMIN ? await connect(cfg.DATABASE_URL_ADMIN) : undefined;
  let owner: pg.Client | undefined;
  try {
    if (admin) {
      if (!cfg.DATABASE_URL_APP_SYSTEM) throw new Error('DATABASE_URL_APP_SYSTEM is required to bootstrap roles');
      if (!cfg.DATABASE_URL_APP_AUTH) throw new Error('DATABASE_URL_APP_AUTH is required to bootstrap roles');
      await lock(admin);
      await bootstrapRoles(admin, [
        credentialFromUrl('app_owner', cfg.DATABASE_URL_APP_OWNER),
        credentialFromUrl('app_user', cfg.DATABASE_URL_APP_USER),
        credentialFromUrl('app_system', cfg.DATABASE_URL_APP_SYSTEM),
        credentialFromUrl('app_public', cfg.DATABASE_URL_APP_PUBLIC),
        credentialFromUrl('app_auth', cfg.DATABASE_URL_APP_AUTH),
      ]);
      log.info('db roles bootstrapped');
    } else {
      log.info('DATABASE_URL_ADMIN not set: skipping role bootstrap');
    }

    owner = await connect(cfg.DATABASE_URL_APP_OWNER);
    if (!admin) await lock(owner);

    if (existsSync(join(folder, 'meta', '_journal.json'))) {
      await migrate(drizzle({ client: owner }), { migrationsFolder: folder });
      log.info({ folder }, 'migrations applied');
    } else {
      log.info({ folder }, 'no migrations generated yet');
    }
  } finally {
    // Ending the session releases its advisory lock.
    await owner?.end();
    await admin?.end();
  }
}

/**
 * `pnpm db:rls`: applies the SQL generated from the registry as `app_owner` (under the migration
 * lock), then runs the guard. Returns the guard's problems; empty means the database matches.
 */
export async function runRls(
  cfg: Pick<MigrateConfig, 'DATABASE_URL_APP_OWNER'>,
  log: Pick<Logger, 'info'>,
  reg: TenantRegistry = registry,
): Promise<string[]> {
  const owner = await connect(cfg.DATABASE_URL_APP_OWNER);
  try {
    await lock(owner);
    await applyRls(owner, generateRlsSql(reg));
    log.info({ tables: Object.keys(reg.tenant).length + Object.keys(reg.global).length }, 'rls applied');
    return await checkRls(owner, reg);
  } finally {
    await owner.end();
  }
}
