import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, databaseAdminEnv, databaseEnv, databaseOwnerEnv } from '@inmolink/platform/config';
import type { Logger } from '@inmolink/platform/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { bootstrapRoles, credentialFromUrl } from './bootstrap';
import { buildConcurrentIndexes } from './concurrent-indexes';
import { CATALOG_STAMP_FUNCTION, checkRls, rlsCatalogStamp } from './tenancy/guard';
import { registry, type TenantRegistry } from './tenancy/registry';
import { applyRls, generateRlsSql, HELPER_FUNCTIONS } from './tenancy/rls';

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
 * pending drizzle-kit migrations as `app_owner` over a direct (non-PgBouncer) connection, after building the
 * large tables' new indexes concurrently (`concurrent-indexes.ts`).
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
      if (!cfg.DATABASE_URL_APP_STAFF) throw new Error('DATABASE_URL_APP_STAFF is required to bootstrap roles');
      if (!cfg.DATABASE_URL_APP_MEDIA) throw new Error('DATABASE_URL_APP_MEDIA is required to bootstrap roles');
      await lock(admin);
      await bootstrapRoles(admin, [
        credentialFromUrl('app_owner', cfg.DATABASE_URL_APP_OWNER),
        credentialFromUrl('app_user', cfg.DATABASE_URL_APP_USER),
        credentialFromUrl('app_system', cfg.DATABASE_URL_APP_SYSTEM),
        credentialFromUrl('app_public', cfg.DATABASE_URL_APP_PUBLIC),
        credentialFromUrl('app_auth', cfg.DATABASE_URL_APP_AUTH),
        credentialFromUrl('app_staff', cfg.DATABASE_URL_APP_STAFF),
        credentialFromUrl('app_media', cfg.DATABASE_URL_APP_MEDIA),
      ]);
      log.info('db roles bootstrapped');
    } else {
      log.info('DATABASE_URL_ADMIN not set: skipping role bootstrap');
    }

    owner = await connect(cfg.DATABASE_URL_APP_OWNER);
    if (!admin) await lock(owner);

    if (existsSync(join(folder, 'meta', '_journal.json'))) {
      // Large tables' new indexes first, outside the migrator's transaction (S5-F2).
      await buildConcurrentIndexes(owner, log, undefined, folder);
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
 * Guard problems that applying `reg` would fix: those about its own tables and the helper functions.
 * Problems about relations or functions outside the registry (e.g. isolation fixtures) need other work.
 */
export function fixableProblems(problems: string[], reg: TenantRegistry): string[] {
  const subjects = new Set<string>([
    ...Object.keys(reg.tenant),
    ...Object.keys(reg.global),
    ...HELPER_FUNCTIONS.map((f) => `${f}()`),
  ]);
  return problems.filter((p) => p.includes(':') && subjects.has(p.slice(0, p.indexOf(':'))));
}

/** Stamp of the last applied RLS SQL, kept as the comment of a generated helper function. */
const STAMP_SQL = `select obj_description(to_regprocedure('public.app_agency()'), 'pg_proc') as stamp`;
export const rlsStamp = (sql: string) => `rls sha256:${createHash('sha256').update(sql).digest('hex')}`;

/**
 * `pnpm db:rls`: applies the SQL generated from the registry as `app_owner` (under the migration
 * lock), then runs the guard. Returns the guard's problems; empty means the database matches.
 * `ifStale` (test setup) skips the apply when the SQL generated now is the SQL last applied (the
 * stamp also covers policy predicates and helper bodies, which the guard does not compare) and the
 * guard finds nothing it would fix: the DDL takes ACCESS EXCLUSIVE locks, and parallel suites
 * re-applying it under each other's queries deadlocked.
 */
export async function runRls(
  cfg: Pick<MigrateConfig, 'DATABASE_URL_APP_OWNER'>,
  log: Pick<Logger, 'info'>,
  reg: TenantRegistry = registry,
  opts: { ifStale?: boolean } = {},
): Promise<string[]> {
  const owner = await connect(cfg.DATABASE_URL_APP_OWNER);
  try {
    await lock(owner);
    const sql = generateRlsSql(reg);
    if (opts.ifStale) {
      const { rows } = await owner.query<{ stamp: string | null }>(STAMP_SQL);
      const problems = rows[0]?.stamp === rlsStamp(sql) ? await checkRls(owner, reg) : undefined;
      if (problems && fixableProblems(problems, reg).length === 0) {
        log.info('rls current: skipped apply');
        return problems;
      }
    }
    await applyRls(owner, sql);
    await owner.query(`comment on function public.app_agency() is '${rlsStamp(sql)}'`);
    // What the guard compares policy predicates and helper bodies against (S1-07).
    await owner.query(`comment on function ${CATALOG_STAMP_FUNCTION} is '${await rlsCatalogStamp(owner)}'`);
    log.info({ tables: Object.keys(reg.tenant).length + Object.keys(reg.global).length }, 'rls applied');
    return await checkRls(owner, reg);
  } finally {
    await owner.end();
  }
}
